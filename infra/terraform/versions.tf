terraform {
  required_version = ">= 1.5.0"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 7.0"
    }
  }
}

# Authentication: API key from ~/.oci/config (profile selectable). Terraform
# never receives the key itself, only the profile name.
provider "oci" {
  region              = var.region
  config_file_profile = var.oci_profile
}
