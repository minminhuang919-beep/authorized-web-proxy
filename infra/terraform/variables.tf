variable "tenancy_ocid" {
  description = "OCID of the tenancy (ocid1.tenancy.oc1..)."
  type        = string
}

variable "compartment_ocid" {
  description = "Compartment to create resources in. Empty = the tenancy root compartment."
  type        = string
  default     = ""
}

variable "region" {
  description = "OCI region identifier, e.g. eu-frankfurt-1. Always Free instances must be created in the home region."
  type        = string
}

variable "oci_profile" {
  description = "Profile name in ~/.oci/config."
  type        = string
  default     = "DEFAULT"
}

variable "instance_name" {
  description = "Display name / hostname prefix for the instance."
  type        = string
  default     = "anonview-proxy"
}

variable "instance_shape" {
  description = "Compute shape. VM.Standard.A1.Flex (ARM, Always Free) or VM.Standard.E2.1.Micro (x86, Always Free fallback)."
  type        = string
  default     = "VM.Standard.A1.Flex"
}

variable "instance_ocpus" {
  description = "OCPUs for flexible shapes (Always Free allows up to 4 A1 OCPUs per tenancy)."
  type        = number
  default     = 2
}

variable "instance_memory_gb" {
  description = "Memory in GB for flexible shapes (Always Free allows up to 24 GB per tenancy)."
  type        = number
  default     = 12
}

variable "boot_volume_size_gb" {
  description = "Boot volume size in GB (Always Free block storage totals 200 GB)."
  type        = number
  default     = 50
}

variable "availability_domain" {
  description = "Availability domain name (e.g. Uocm:EU-FRANKFURT-1-AD-1). Empty = first AD. The deploy script picks one with A1 capacity."
  type        = string
  default     = ""
}

variable "ubuntu_version" {
  description = "Canonical Ubuntu release to use for the platform image."
  type        = string
  default     = "24.04"
}

variable "ssh_public_key" {
  description = "Contents of the SSH public key authorised for the ubuntu user."
  type        = string
}

variable "ssh_allowed_cidr" {
  description = "CIDR allowed to reach port 22. Restrict to your own IP (e.g. 203.0.113.7/32) when possible."
  type        = string
  default     = "0.0.0.0/0"
}

variable "reserved_public_ip" {
  description = "Attach a reserved (stable) public IP instead of an ephemeral one."
  type        = bool
  default     = true
}

variable "app_dir" {
  description = "Directory on the server where the application is deployed."
  type        = string
  default     = "/opt/anonview"
}
