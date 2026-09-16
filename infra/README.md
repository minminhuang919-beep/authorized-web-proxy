# Infrastructure

Everything needed to run AnonView on an Oracle Cloud Infrastructure (OCI)
Always Free Ampere A1 instance. The top-level `deploy.sh` / `destroy.sh`
drive these pieces; you rarely need to run them by hand.

```
infra/
├── terraform/
│   ├── versions.tf               provider (oracle/oci ~> 7.0), API-key auth via ~/.oci/config
│   ├── variables.tf              all inputs (shape, size, region, SSH CIDR, …)
│   ├── main.tf                   VCN, IGW, route table, security list, subnet, instance, reserved IP
│   ├── outputs.tf                public_ip, instance_id, ssh_command, …
│   ├── cloud-init.yaml.tftpl     first-boot: Docker, firewall, fail2ban, unattended upgrades
│   └── terraform.tfvars.example  for running Terraform manually
└── scripts/
    ├── lib.sh                    shared helpers (deploy.env loader, OCI config parser, ssh)
    ├── oci-check-auth.sh         verifies credentials, prints tenancy/home region (exit 2 = missing)
    ├── oci-capacity.sh           Compute Capacity Report per AD/shape; exit 3 = no capacity
    ├── wait-for-ssh.sh           waits for SSH + cloud-init completion
    ├── remote-deploy.sh          runs ON the server: compose build/up, health wait, prune
    ├── remote-diagnostics.sh     runs ON the server: CPU/RAM/disk/containers/firewall/logs
    └── selftest-deploy.sh        offline test of deploy.sh's upload + .env composition
```

## Resources created

| Resource | Notes |
|---|---|
| VCN `10.0.0.0/16` + internet gateway + route table | DNS label `anonview` |
| Security list | Ingress: 22/tcp from `ssh_allowed_cidr`, 80/tcp, 443/tcp, 443/udp from anywhere, ICMP type 3 code 4 (PMTUD); egress: all |
| Public subnet `10.0.1.0/24` | Uses only the security list above (the VCN default list is not attached) |
| Instance `VM.Standard.A1.Flex` 2 OCPU / 12 GB, Ubuntu 24.04 aarch64, 50 GB boot volume | `RESTORE_INSTANCE` recovery; image/AD changes ignored after creation so the server is never rebuilt by accident |
| Reserved public IP | Stable across stop/start and rebuilds (`reserved_public_ip = false` for an ephemeral one) |

Cost: all of the above fits in Always Free (see README §16).

## Host configuration (cloud-init)

1. `iptables`: Oracle's Ubuntu images reject all inbound traffic except SSH
   by default; ports 80/443 (tcp) and 443 (udp) are opened and persisted
   with `netfilter-persistent` **before** Docker is installed so the saved
   rule set never contains Docker's dynamic chains.
2. Docker Engine + Compose plugin from `download.docker.com` (arm64/amd64),
   `ubuntu` added to the `docker` group, `/etc/docker/daemon.json` with log
   rotation (10 MB × 3) and `live-restore`.
3. `/opt/anonview` owned by `ubuntu` (the deploy target).
4. A 1 GB swap file when RAM < 2 GB (x86 micro fallback).
5. fail2ban (sshd jail, systemd backend) and unattended-upgrades with
   automatic reboots at 04:30.

## Running Terraform manually

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # fill in
terraform init
terraform plan
terraform apply
terraform output
```

`deploy.sh` writes `generated.auto.tfvars.json` instead; both files are
git-ignored, as is the state (`terraform.tfstate`). **Keep the state file** —
it is how `destroy.sh` knows what to remove. If you lose it, delete the
resources from the OCI console (Compute → Instances, Networking → VCNs,
Networking → Reserved public IPs).

## Capacity handling

`oci-capacity.sh` calls `oci compute compute-capacity-report create` for
each availability domain in the home region and each candidate
configuration (requested size → 1 OCPU/6 GB → optional x86 micro). It only
returns a configuration reported `AVAILABLE`. `deploy.sh` then applies
Terraform; if the launch still fails with a capacity error (the window
between report and launch), that AD is excluded and the check is repeated,
at most three times in total. There is no blind retry loop and no random
instance creation.

## Manual server access

```bash
ssh -i ~/.ssh/anonview ubuntu@<public-ip>
sudo cloud-init status --long
docker compose -f /opt/anonview/docker-compose.yml ps
```

## Monitoring cheat-sheet (on the server)

```bash
htop                              # CPU / memory per process
free -h                           # memory
df -h /                           # disk
docker stats --no-stream          # per-container CPU / RAM / network
docker compose ps                 # health status
curl -s http://127.0.0.1/health   # application health (JSON)
sudo iptables -S INPUT            # host firewall
sudo fail2ban-client status sshd  # banned IPs
```

`./deploy.sh status` prints all of the above from your machine.
