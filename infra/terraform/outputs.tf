output "public_ip" {
  description = "Public IPv4 address of the proxy server."
  value       = var.reserved_public_ip ? oci_core_public_ip.reserved[0].ip_address : oci_core_instance.proxy.public_ip
}

output "instance_id" {
  description = "OCID of the compute instance."
  value       = oci_core_instance.proxy.id
}

output "instance_name" {
  value = oci_core_instance.proxy.display_name
}

output "availability_domain" {
  value = oci_core_instance.proxy.availability_domain
}

output "shape" {
  value = oci_core_instance.proxy.shape
}

output "ocpus" {
  value = local.is_flex ? var.instance_ocpus : null
}

output "memory_gb" {
  value = local.is_flex ? var.instance_memory_gb : null
}

output "image_name" {
  value = data.oci_core_images.ubuntu.images[0].display_name
}

output "region" {
  value = var.region
}

output "ssh_command" {
  description = "How to reach the server."
  value       = "ssh ubuntu@${var.reserved_public_ip ? oci_core_public_ip.reserved[0].ip_address : oci_core_instance.proxy.public_ip}"
}
