locals {
  compartment_ocid = var.compartment_ocid != "" ? var.compartment_ocid : var.tenancy_ocid
  is_flex          = endswith(var.instance_shape, ".Flex")
  tags = {
    project    = "anonview"
    managed_by = "terraform"
  }
}

# ---------------------------------------------------------------------------
# Lookups
# ---------------------------------------------------------------------------

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

# Latest Canonical Ubuntu platform image compatible with the chosen shape
# (aarch64 for A1, x86_64 for E2). "Minimal" variants are excluded.
data "oci_core_images" "ubuntu" {
  compartment_id           = local.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = var.ubuntu_version
  shape                    = var.instance_shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"

  filter {
    name   = "display_name"
    values = ["^Canonical-Ubuntu-${replace(var.ubuntu_version, ".", "\\.")}-(aarch64-)?[0-9]{4}\\.[0-9]{2}\\.[0-9]{2}-[0-9]+$"]
    regex  = true
  }
}

locals {
  availability_domain = var.availability_domain != "" ? var.availability_domain : data.oci_identity_availability_domains.ads.availability_domains[0].name
  image_id            = data.oci_core_images.ubuntu.images[0].id
}

# ---------------------------------------------------------------------------
# Networking: VCN, internet gateway, route table, security list, public subnet
# ---------------------------------------------------------------------------

resource "oci_core_vcn" "vcn" {
  compartment_id = local.compartment_ocid
  display_name   = "${var.instance_name}-vcn"
  cidr_blocks    = ["10.0.0.0/16"]
  dns_label      = "anonview"
  freeform_tags  = local.tags
}

resource "oci_core_internet_gateway" "igw" {
  compartment_id = local.compartment_ocid
  vcn_id         = oci_core_vcn.vcn.id
  display_name   = "${var.instance_name}-igw"
  enabled        = true
  freeform_tags  = local.tags
}

resource "oci_core_route_table" "public" {
  compartment_id = local.compartment_ocid
  vcn_id         = oci_core_vcn.vcn.id
  display_name   = "${var.instance_name}-public-rt"
  freeform_tags  = local.tags

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.igw.id
  }
}

# Only what the proxy needs: SSH (restricted CIDR), HTTP, HTTPS (TCP + UDP for
# HTTP/3) and the ICMP messages required for path-MTU discovery.
resource "oci_core_security_list" "public" {
  compartment_id = local.compartment_ocid
  vcn_id         = oci_core_vcn.vcn.id
  display_name   = "${var.instance_name}-public-sl"
  freeform_tags  = local.tags

  egress_security_rules {
    destination      = "0.0.0.0/0"
    destination_type = "CIDR_BLOCK"
    protocol         = "all"
    description      = "Allow all outbound traffic"
  }

  ingress_security_rules {
    source      = var.ssh_allowed_cidr
    source_type = "CIDR_BLOCK"
    protocol    = "6"
    description = "SSH"
    tcp_options {
      min = 22
      max = 22
    }
  }

  ingress_security_rules {
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    protocol    = "6"
    description = "HTTP (redirects to HTTPS when a domain is configured)"
    tcp_options {
      min = 80
      max = 80
    }
  }

  ingress_security_rules {
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    protocol    = "6"
    description = "HTTPS"
    tcp_options {
      min = 443
      max = 443
    }
  }

  ingress_security_rules {
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    protocol    = "17"
    description = "HTTPS over QUIC (HTTP/3)"
    udp_options {
      min = 443
      max = 443
    }
  }

  ingress_security_rules {
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    protocol    = "1"
    description = "ICMP path MTU discovery"
    icmp_options {
      type = 3
      code = 4
    }
  }

  ingress_security_rules {
    source      = "10.0.0.0/16"
    source_type = "CIDR_BLOCK"
    protocol    = "1"
    description = "ICMP within the VCN"
    icmp_options {
      type = 3
    }
  }
}

resource "oci_core_subnet" "public" {
  compartment_id             = local.compartment_ocid
  vcn_id                     = oci_core_vcn.vcn.id
  display_name               = "${var.instance_name}-public-subnet"
  cidr_block                 = "10.0.1.0/24"
  dns_label                  = "public"
  route_table_id             = oci_core_route_table.public.id
  security_list_ids          = [oci_core_security_list.public.id]
  prohibit_public_ip_on_vnic = false
  freeform_tags              = local.tags
}

# ---------------------------------------------------------------------------
# Compute instance (Always Free Ampere A1 by default)
# ---------------------------------------------------------------------------

resource "oci_core_instance" "proxy" {
  compartment_id      = local.compartment_ocid
  availability_domain = local.availability_domain
  display_name        = var.instance_name
  shape               = var.instance_shape
  freeform_tags       = local.tags

  dynamic "shape_config" {
    for_each = local.is_flex ? [1] : []
    content {
      ocpus         = var.instance_ocpus
      memory_in_gbs = var.instance_memory_gb
    }
  }

  source_details {
    source_type             = "image"
    source_id               = local.image_id
    boot_volume_size_in_gbs = var.boot_volume_size_gb
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    display_name     = "${var.instance_name}-vnic"
    hostname_label   = "proxy"
    assign_public_ip = var.reserved_public_ip ? false : true
  }

  metadata = {
    ssh_authorized_keys = trimspace(var.ssh_public_key)
    user_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
      app_dir = var.app_dir
    }))
  }

  agent_config {
    is_management_disabled = false
    is_monitoring_disabled = false
  }

  availability_config {
    recovery_action = "RESTORE_INSTANCE"
  }

  # The boot volume is deleted together with the instance (destroy.sh warns).
  preserve_boot_volume = false

  lifecycle {
    # A newer platform image or edited cloud-init must never force a rebuild
    # of a running server; recreate deliberately with `terraform taint`.
    ignore_changes = [source_details[0].source_id, metadata, availability_domain]
  }
}

# ---------------------------------------------------------------------------
# Reserved (stable) public IP attached to the primary VNIC
# ---------------------------------------------------------------------------

data "oci_core_vnic_attachments" "primary" {
  compartment_id = local.compartment_ocid
  instance_id    = oci_core_instance.proxy.id
}

data "oci_core_private_ips" "primary" {
  vnic_id = data.oci_core_vnic_attachments.primary.vnic_attachments[0].vnic_id
}

resource "oci_core_public_ip" "reserved" {
  count          = var.reserved_public_ip ? 1 : 0
  compartment_id = local.compartment_ocid
  display_name   = "${var.instance_name}-ip"
  lifetime       = "RESERVED"
  private_ip_id  = data.oci_core_private_ips.primary.private_ips[0].id
  freeform_tags  = local.tags
}
