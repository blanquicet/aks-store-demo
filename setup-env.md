# Setup environment

This file contains a guide to create the environment used to run the
troubleshooting networking demos presented during the session.

## Table of contents

- [Setup environment](#setup-environment)
  - [Table of contents](#table-of-contents)
  - [Create the resource group and cluster](#create-the-resource-group-and-cluster)
    - [Clean up](#clean-up)
  - [Create VM to act as external endpoint](#create-vm-to-act-as-external-endpoint)
    - [Create (External endpoint) VM](#create-external-endpoint-vm)
    - [Create public IP for (External endpoint) VM](#create-public-ip-for-external-endpoint-vm)
    - [Configure VM as endpoint server (HTTP)](#configure-vm-as-endpoint-server-http)
    - [Remove (External endpoint) VM's public IP](#remove-external-endpoint-vms-public-ip)
  - [Create VM to act as custom DNS for the cluster](#create-vm-to-act-as-custom-dns-for-the-cluster)
    - [Create (DNS) VM](#create-dns-vm)
    - [Create public IP for (DNS) VM](#create-public-ip-for-dns-vm)
    - [Configure VM as DNS server](#configure-vm-as-dns-server)
      - [Create scripts to break and fix DNS](#create-scripts-to-break-and-fix-dns)
    - [Configure cluster nodes to use VM as DNS server](#configure-cluster-nodes-to-use-vm-as-dns-server)
    - [Remove (DNS) VM's public IP](#remove-dns-vms-public-ip)
  - [Delete a VM](#delete-a-vm)

Start by setting the following environment variables. Notice `PREFIX` will be
used as prefix for the name of all the resources created. Change it if you are
creating a second (back-up) environment:

```bash
PREFIX="build-demo"
LOCATION="westus3"
```

## Create the resource group and cluster

```bash
RESOURCE_GROUP="$PREFIX-rg"
CLUSTER_NAME="$PREFIX-cluster"

az group create \
  --name $RESOURCE_GROUP \
  --location $LOCATION

# Create cluster
# Use Azure Network Policy Manager for enforcing k8s network policies (Calico and Cilium are the other two options, but didn't try): https://learn.microsoft.com/en-us/azure/aks/use-network-policies
# Enable App routing to use the managed NGINX ingress: https://docs.azure.cn/en-us/aks/app-routing?tabs=default%2Cdeploy-app-default
az aks create \
  --name $CLUSTER_NAME \
  --resource-group $RESOURCE_GROUP \
  --node-count 3 \
  --network-plugin azure \
  --network-policy azure \
  --os-sku=Ubuntu \
  --enable-app-routing \
  --generate-ssh-keys

az aks get-credentials --resource-group $RESOURCE_GROUP --name $CLUSTER_NAME
```

### Clean up

```bash
az group delete \
  --name $RESOURCE_GROUP \
  --yes
```

## Create VM to act as external endpoint

General environment variables:

```bash
SERVER_VMNAME="$PREFIX-server-vm"
USERNAME="azureuser"
SERVER_VM_PUBLIC_IP_NAME="server-tmp-pip"
SERVER_VM_NIC_NAME=${SERVER_VMNAME}Nic
```

Get the name of the resource group where the nodes are running:

```bash
PROVIDER_ID=$(kubectl get nodes -o jsonpath='{.items[0].spec.providerID}')
echo "PROVIDER_ID=$PROVIDER_ID"

NODE_RESOURCE_GROUP=$(echo $PROVIDER_ID | sed -n 's|.*/resourceGroups/\([^/]*\)/providers/.*|\1|p')
echo "NODE_RESOURCE_GROUP=$NODE_RESOURCE_GROUP"
```

We want to create the VM within the same vnet and subnet of the nodes so that
they can communicate.

Retrieve subnet, vnet and network security group of the VMSS:

```bash
SUBNET_ID=$(az vmss show \
  --resource-group $NODE_RESOURCE_GROUP \
  --name "$(echo $PROVIDER_ID | sed -n 's|.*/virtualMachineScaleSets/\([^/]*\)/virtualMachines/.*|\1|p')" \
  --query "virtualMachineProfile.networkProfile.networkInterfaceConfigurations[0].ipConfigurations[0].subnet.id" \
  -o tsv)
echo "SUBNET_ID=$SUBNET_ID"

VNET_NAME=$(echo $SUBNET_ID | sed -n 's|.*/virtualNetworks/\([^/]*\)/subnets/.*|\1|p')
echo "VNET_NAME=$VNET_NAME"

SUBNET_NAME=$(echo $SUBNET_ID | sed 's|.*/subnets/||')
echo "SUBNET_NAME=$SUBNET_NAME"

NSG_ID=$(az network vnet subnet show \
  --resource-group $NODE_RESOURCE_GROUP \
  --vnet-name    $VNET_NAME \
  --name         $SUBNET_NAME \
  --query        networkSecurityGroup.id \
  -o tsv)
echo "NSG_ID=$NSG_ID"

NSG_NAME=$(echo $NSG_ID | sed 's|.*/networkSecurityGroups/||')
echo "NSG_NAME=$NSG_NAME"
```

Create a NIC in the same VMSS' VNet/Subnet/NSG without a public IP. Notice that,
by default, this NIC will have no public-IP resource attached. Also, set Azure
DNS server (168.63.129.16) as DNS server:

```bash
az network nic create \
  --resource-group $NODE_RESOURCE_GROUP \
  --name $SERVER_VM_NIC_NAME \
  --vnet-name $VNET_NAME \
  --subnet    $SUBNET_NAME \
  --network-security-group $NSG_NAME \
  --dns-servers 168.63.129.16
echo "SERVER_VM_NIC_NAME=$SERVER_VM_NIC_NAME"
```

Retrieve the ipconfig name. It will be useful later to attach a public IP when
we will need to access it:

```bash
IPCONFIG_NAME=$(az network nic ip-config list \
  --resource-group $NODE_RESOURCE_GROUP \
  --nic-name      $SERVER_VM_NIC_NAME \
  --query "[0].name" -o tsv)
echo "IPCONFIG_NAME=$IPCONFIG_NAME"
```

### Create (External endpoint) VM

Create VM with the NIC previously created:

```bash
az vm create \
  --resource-group $NODE_RESOURCE_GROUP \
  --name $SERVER_VMNAME \
  --image Canonical:ubuntu-24_04-lts:server:latest \
  --nics $SERVER_VM_NIC_NAME \
  --admin-username $USERNAME \
  --generate-ssh-keys
```

### Create public IP for (External endpoint) VM

Add public IP to access VM from Internet:

```bash
# 1) Create a temporary Public IP
az network public-ip create \
  --resource-group $NODE_RESOURCE_GROUP \
  --name          $SERVER_VM_PUBLIC_IP_NAME \
  --sku           Standard \
  --allocation-method Static
echo "SERVER_VM_PUBLIC_IP_NAME=$SERVER_VM_PUBLIC_IP_NAME"

# 2) Associate it to your NIC’s IP‐configuration
az network nic ip-config update \
  --resource-group      $NODE_RESOURCE_GROUP \
  --nic-name            $SERVER_VM_NIC_NAME \
  --name                $IPCONFIG_NAME \
  --public-ip-address   $SERVER_VM_PUBLIC_IP_NAME

# 3) Add rule to the NSG that allows 22 inbound traffic
az network nsg rule create \
  --resource-group $NODE_RESOURCE_GROUP \
  --nsg-name    $NSG_NAME \
  --name        AllowSSH \
  --priority    102 \
  --direction   Inbound \
  --access      Allow \
  --protocol    Tcp \
  --source-address-prefixes '*' \
  --source-port-ranges      '*' \
  --destination-address-prefixes '*' \
  --destination-port-ranges 22

# 4) Now the VM has a public address:
PIP=$(az network public-ip show \
  --resource-group $NODE_RESOURCE_GROUP \
  --name          $SERVER_VM_PUBLIC_IP_NAME \
  --query         ipAddress -o tsv)
echo "ssh $USERNAME@$PIP"
```

### Configure VM as endpoint server (HTTP)

```bash
# 0) SSH to the VM
ssh -o StrictHostKeyChecking=no $USERNAME@$PIP

# 1) Install python3 if you don’t have it
sudo apt update && sudo apt install -y python3

# 2) Create a directory to serve files from
mkdir -p ~/www && echo "Hello from $(hostname)" > ~/www/index.html
cd ~/www

# 3) Run a simple HTTP server on port 80 (In background)
sudo nohup python3 -m http.server 80 >/dev/null 2>&1 &

# 4) Check the server is running
curl -s 127.0.0.1
```

Get VM's private IP:

```bash
SERVER_VM_PRIVATE_IP=$(az network nic ip-config show \
  --resource-group      $NODE_RESOURCE_GROUP \
  --nic-name            $SERVER_VM_NIC_NAME \
  --name                $IPCONFIG_NAME \
  --query privateIPAddress -o tsv)
echo "SERVER_VM_PRIVATE_IP=$SERVER_VM_PRIVATE_IP"
```

### Remove (External endpoint) VM's public IP

```bash
PROVIDER_ID=$(kubectl get nodes -o jsonpath='{.items[0].spec.providerID}')
echo "PROVIDER_ID=$PROVIDER_ID"

NODE_RESOURCE_GROUP=$(echo $PROVIDER_ID | sed -n 's|.*/resourceGroups/\([^/]*\)/providers/.*|\1|p')
echo "NODE_RESOURCE_GROUP=$NODE_RESOURCE_GROUP"

IPCONFIG_NAME=$(az network nic ip-config list \
  --resource-group $NODE_RESOURCE_GROUP \
  --nic-name       $SERVER_VM_NIC_NAME \
  --query "[0].name" -o tsv)
echo "IPCONFIG_NAME=$IPCONFIG_NAME"

# Remove the Public IP from the NIC, and then the Public IP
az network nic ip-config update \
  --resource-group      $NODE_RESOURCE_GROUP \
  --nic-name            $SERVER_VM_NIC_NAME \
  --name                $IPCONFIG_NAME \
  --remove              publicIpAddress
az network public-ip delete \
  --resource-group $NODE_RESOURCE_GROUP \
  --name          $SERVER_VM_PUBLIC_IP_NAME
```

## Create VM to act as custom DNS for the cluster

General environment variables:

```bash
VMNAME="$PREFIX-vm"
USERNAME="azureuser"
PUBLIC_IP_NAME="tmp-pip"
NIC_NAME=${VMNAME}Nic
```

Get the name of the resource group where the nodes are running:

```bash
PROVIDER_ID=$(kubectl get nodes -o jsonpath='{.items[0].spec.providerID}')
echo "PROVIDER_ID=$PROVIDER_ID"

NODE_RESOURCE_GROUP=$(echo $PROVIDER_ID | sed -n 's|.*/resourceGroups/\([^/]*\)/providers/.*|\1|p')
echo "NODE_RESOURCE_GROUP=$NODE_RESOURCE_GROUP"
```

We want to create the VM within the same vnet and subnet of the nodes so that
they can communicate.

Retrieve subnet, vnet and network security group of the VMSS:

```bash
SUBNET_ID=$(az vmss show \
  --resource-group $NODE_RESOURCE_GROUP \
  --name "$(echo $PROVIDER_ID | sed -n 's|.*/virtualMachineScaleSets/\([^/]*\)/virtualMachines/.*|\1|p')" \
  --query "virtualMachineProfile.networkProfile.networkInterfaceConfigurations[0].ipConfigurations[0].subnet.id" \
  -o tsv)
echo "SUBNET_ID=$SUBNET_ID"

VNET_NAME=$(echo $SUBNET_ID | sed -n 's|.*/virtualNetworks/\([^/]*\)/subnets/.*|\1|p')
echo "VNET_NAME=$VNET_NAME"

SUBNET_NAME=$(echo $SUBNET_ID | sed 's|.*/subnets/||')
echo "SUBNET_NAME=$SUBNET_NAME"

NSG_ID=$(az network vnet subnet show \
  --resource-group $NODE_RESOURCE_GROUP \
  --vnet-name    $VNET_NAME \
  --name         $SUBNET_NAME \
  --query        networkSecurityGroup.id \
  -o tsv)
echo "NSG_ID=$NSG_ID"

NSG_NAME=$(echo $NSG_ID | sed 's|.*/networkSecurityGroups/||')
echo "NSG_NAME=$NSG_NAME"
```

Create a NIC in the same VMSS' VNet/Subnet/NSG without a public IP. Notice that,
by default, this NIC will have no public-IP resource attached. Also, set Azure
DNS server (168.63.129.16) as DNS server:

```bash
az network nic create \
  --resource-group $NODE_RESOURCE_GROUP \
  --name $NIC_NAME \
  --vnet-name $VNET_NAME \
  --subnet    $SUBNET_NAME \
  --network-security-group $NSG_NAME \
  --dns-servers 168.63.129.16
echo "NIC_NAME=$NIC_NAME"
```

Retrieve the ipconfig name. It will be useful later to attach a public IP when
we will need to access it:

```bash
IPCONFIG_NAME=$(az network nic ip-config list \
  --resource-group $NODE_RESOURCE_GROUP \
  --nic-name      $NIC_NAME \
  --query "[0].name" -o tsv)
echo "IPCONFIG_NAME=$IPCONFIG_NAME"
```

### Create (DNS) VM

Create VM with the NIC previously created:

```bash
az vm create \
    --resource-group $NODE_RESOURCE_GROUP \
    --name $VMNAME \
    --image Canonical:ubuntu-24_04-lts:server:latest \
    --nics $NIC_NAME \
    --admin-username $USERNAME \
    --generate-ssh-keys
```

### Create public IP for (DNS) VM

Add public IP to access VM from Internet:

```bash
# 1) Create a temporary Public IP
az network public-ip create \
  --resource-group $NODE_RESOURCE_GROUP \
  --name          $PUBLIC_IP_NAME \
  --sku           Standard \
  --allocation-method Static
echo "PUBLIC_IP_NAME=$PUBLIC_IP_NAME"

# 2) Associate it to your NIC’s IP‐configuration
az network nic ip-config update \
  --resource-group      $NODE_RESOURCE_GROUP \
  --nic-name            $NIC_NAME \
  --name                $IPCONFIG_NAME \
  --public-ip-address   $PUBLIC_IP_NAME

# 3) Add rule to the NSG that allows 22 inbound traffic
az network nsg rule create \
  --resource-group $NODE_RESOURCE_GROUP \
  --nsg-name    $NSG_NAME \
  --name        AllowSSH \
  --priority    102 \
  --direction   Inbound \
  --access      Allow \
  --protocol    Tcp \
  --source-address-prefixes '*' \
  --source-port-ranges      '*' \
  --destination-address-prefixes '*' \
  --destination-port-ranges 22

# 4) Now the VM has a public address:
PIP=$(az network public-ip show \
  --resource-group $NODE_RESOURCE_GROUP \
  --name          $PUBLIC_IP_NAME \
  --query         ipAddress -o tsv)
echo "ssh $USERNAME@$PIP"
```

### Configure VM as DNS server

Use `dsnmasq` to act as a DNS resolver but disable systemd-resolved (otherwise
they will conflict).

```bash
# SSH to the VM
ssh -o StrictHostKeyChecking=no $USERNAME@$PIP

# Install dnsmasq
sudo apt update && sudo apt install -y dnsmasq

# Disable & stop systemd-resolved
sudo systemctl disable --now systemd-resolved

# Unlink the resolved stub resolv.conf
sudo rm /etc/resolv.conf

# Configure dnsmasq to use Azure DNS as primary upstream server
sudo tee /etc/dnsmasq.d/01-upstream.conf <<EOF
# ignore /etc/resolv.conf so only these servers are used
no-resolv
# primary upstream DNS servers
server=168.63.129.16
EOF

# Configure dnsqmasq to resolve myexternalendpoint.com with the IP of the VM acting as HTTP serve
# FIXME: Update IP (SERVER_VM_PRIVATE_IP)
sudo tee /etc/dnsmasq.d/10-custom-hosts.conf <<EOF
# Resolve custom host
address=/myexternalendpoint.com/10.224.0.91
EOF

# Restart dnsmasq so it picks up your configs
sudo systemctl enable --now dnsmasq
```

Validate DNS are being resolved:

```bash
dig 127.0.0.1 microsoft.com +short
dig 127.0.0.1 myexternalendpoint.com +short
```

NOTE: I was getting several warning about not being able to resolve the
hostname. I solved it by doing this:

```bash
sudo vi /etc/hosts

# Resolve custom host (FIXME: Add VMNAME)
127.0.1.1   <VMNAME>
```

#### Create scripts to break and fix DNS

NOTE: Update these scripts to use private IP of VM acting as external endpoint
(`SERVER_VM_PRIVATE_IP`).

Script to break things:

```bash
sudo nano /usr/local/bin/break-dns-configuration.sh
```

Content:

```text
#!/bin/bash

echo "Breaking DNS configuration"
sudo tee /etc/dnsmasq.d/10-custom-hosts.conf <<EOF
# SIMULATE ISSUE:
# Send all myexternalendpoint.com lookups to 127.0.0.1#53535 (nothing is listening there)
server=/myexternalendpoint.com/127.0.0.1#53535
EOF

echo "Restarting dnsmasq..."
sudo systemctl restart dnsmasq
```

Script to fix things:

```bash
sudo nano /usr/local/bin/fix-dns-configuration.sh
```

Content:

```text
#!/bin/bash

echo "Fixing DNS configuration"
sudo tee /etc/dnsmasq.d/10-custom-hosts.conf <<EOF
# WORKING SCENARIO:
# Resolve custom host
address=/myexternalendpoint.com/10.224.0.91
EOF

echo "Restarting dnsmasq..."
sudo systemctl restart dnsmasq
```

Make them both executable:

```bash
sudo chmod +x /usr/local/bin/break-dns-configuration.sh
sudo chmod +x /usr/local/bin/fix-dns-configuration.sh
```

### Configure cluster nodes to use VM as DNS server

Get VM's private IP:

```bash
PRIVATE_IP=$(az network nic ip-config show \
  --resource-group      $NODE_RESOURCE_GROUP \
  --nic-name            $NIC_NAME \
  --name                $IPCONFIG_NAME \
  --query privateIPAddress -o tsv)
echo "PRIVATE_IP=$PRIVATE_IP"
```

Update cluster nodes' vnet to use VM as DNS server:

```bash
az network vnet update \
  --resource-group $NODE_RESOURCE_GROUP \
  --name        $VNET_NAME \
  --dns-servers $PRIVATE_IP
```

Restart nodes:

```bash
VMSS_NAME=$(az vmss list \
  --resource-group $NODE_RESOURCE_GROUP \
  --query "[?starts_with(name, 'aks-')].name | [0]" \
  -o tsv)
echo "VMSS_NAME=$VMSS_NAME"

az vmss restart \
  --resource-group $NODE_RESOURCE_GROUP \
  --name $VMSS_NAME \
  --instance-ids "*"
```

Wait for the nodes to be back up:

```bash
watch -n 5 "kubectl get nodes"
```

### Remove (DNS) VM's public IP

```bash
PROVIDER_ID=$(kubectl get nodes -o jsonpath='{.items[0].spec.providerID}')
echo "PROVIDER_ID=$PROVIDER_ID"

NODE_RESOURCE_GROUP=$(echo $PROVIDER_ID | sed -n 's|.*/resourceGroups/\([^/]*\)/providers/.*|\1|p')
echo "NODE_RESOURCE_GROUP=$NODE_RESOURCE_GROUP"

IPCONFIG_NAME=$(az network nic ip-config list \
  --resource-group $NODE_RESOURCE_GROUP \
  --nic-name       $NIC_NAME \
  --query "[0].name" -o tsv)
echo "IPCONFIG_NAME=$IPCONFIG_NAME"

# Remove the Public IP from the NIC, and then the Public IP
az network nic ip-config update \
  --resource-group      $NODE_RESOURCE_GROUP \
  --nic-name            $NIC_NAME \
  --name                $IPCONFIG_NAME \
  --remove              publicIpAddress
az network public-ip delete \
  --resource-group $NODE_RESOURCE_GROUP \
  --name          $PUBLIC_IP_NAME
```

## Delete a VM

TODO: Command to delete disk and NIC associated to VMs.

```bash
az vm delete \
    --resource-group $NODE_RESOURCE_GROUP \
    --name $VMNAME \
    --yes
```

```bash
az vm delete \
    --resource-group $NODE_RESOURCE_GROUP \
    --name $SERVER_VMNAME \
    --yes
```
