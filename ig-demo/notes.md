# General
PREFIX="build-demo"
LOCATION="westus3"

# Cluster
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

# Create VM to act as custom DNS for the cluster
VMNAME="$PREFIX-vm6"
USERNAME="azureuser"
PUBLIC_IP_NAME="tmp-pip"
NIC_NAME=${VMNAME}Nic

PROVIDER_ID=$(kubectl get nodes -o jsonpath='{.items[0].spec.providerID}')
echo "PROVIDER_ID=$PROVIDER_ID"

NODE_RESOURCE_GROUP=$(echo $PROVIDER_ID | sed -n 's|.*/resourceGroups/\([^/]*\)/providers/.*|\1|p')
echo "NODE_RESOURCE_GROUP=$NODE_RESOURCE_GROUP"

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

# Create a NIC in your VNet/Subnet/NSG without a public IP
# By default this NIC will have no public-IP resource attached
# Set Azure DNS server (168.63.129.16) as DNS server
az network nic create \
  --resource-group $NODE_RESOURCE_GROUP \
  --name $NIC_NAME \
  --vnet-name $VNET_NAME \
  --subnet    $SUBNET_NAME \
  --network-security-group $NSG_NAME \
  --dns-servers 168.63.129.16
echo "NIC_NAME=$NIC_NAME"

# Retrieve ipconfig name to then update the public IP
IPCONFIG_NAME=$(az network nic ip-config list \
  --resource-group $NODE_RESOURCE_GROUP \
  --nic-name      $NIC_NAME \
  --query "[0].name" -o tsv)
echo "IPCONFIG_NAME=$IPCONFIG_NAME"

# Create VM
# https://learn.microsoft.com/en-us/azure/virtual-machines/windows/quick-create-cli
az vm create \
    --resource-group $NODE_RESOURCE_GROUP \
    --name $VMNAME \
    --image Canonical:ubuntu-24_04-lts:server:latest \
    --nics $NIC_NAME \
    --admin-username $USERNAME \
    --generate-ssh-keys

#Add public IP to access VM from Internet
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

#Edit
# Install dnsmasq
sudo apt update && sudo apt install -y dnsmasq

# Disable & stop systemd-resolved
sudo systemctl disable --now systemd-resolved

# Unlink the resolved stub resolv.conf
sudo rm /etc/resolv.conf


# Resolve custom host (FIXME: Add VMNAME)
127.0.1.1   build-demo-vm6

# Create a new resolv.conf pointing at localhost (dnsmasq)
sudo tee /etc/dnsmasq.d/01-upstream.conf <<EOF
# ignore /etc/resolv.conf so only these servers are used
no-resolv
# primary upstream DNS servers
server=168.63.129.16
EOF

# Resolve  (FIXME: Update server IP)
sudo tee /etc/dnsmasq.d/10-custom-hosts.conf <<EOF
# WORKING SCENARIO:
# Resolve custom host
#address=/myexternalserver.com/10.224.0.92

# SIMULATE ISSUE:
# Send all myexternalserver.com lookups to 127.0.0.1#53535 (nothing is listening there)
server=/myexternalserver.com/127.0.0.1#53535
EOF

# Restart dnsmasq so it picks up your configs
sudo systemctl enable --now dnsmasq

# Validate DNS are being resolved
dig 127.0.0.1 myexternalserver.com +short
dig 127.0.0.1 example.com +short

# Update NSG to use the VM as DNS server
PRIVATE_IP=$(az network nic ip-config show \
  --resource-group      $NODE_RESOURCE_GROUP \
  --nic-name            $NIC_NAME \
  --name                $IPCONFIG_NAME \
  --query privateIPAddress -o tsv)
echo "PRIVATE_IP=$PRIVATE_IP"

az network vnet update \
  --resource-group $NODE_RESOURCE_GROUP \
  --name        $VNET_NAME \
  --dns-servers $PRIVATE_IP

# Restart nodes  
VMSS_NAME=$(az vmss list \
  --resource-group $NODE_RESOURCE_GROUP \
  --query "[?starts_with(name, 'aks-')].name | [0]" \
  -o tsv)
echo "VMSS_NAME=$VMSS_NAME"

az vmss restart \
  --resource-group $NODE_RESOURCE_GROUP \
  --name $VMSS_NAME \
  --instance-ids "*"

# DEEEMOOOO


# Workload
# Clean up
kubectl delete ns ig-demo

## Deploy application

This application is based on example from the [Quickstart: Deploy an Azure
Kubernetes Service (AKS) cluster using Azure
CLI](https://learn.microsoft.com/en-us/azure/aks/learn/quick-kubernetes-deploy-cli).

```bash
kubectl create ns ig-demo
kubectl apply -f aks-store-ingress-quickstart.yaml --namespace ig-demo
```

Wait for the app to be ready:

```bash
kubectl wait --for=condition=Ready pods --all --namespace ig-demo --timeout=120s
```

Check pods and services:

```bash
kubectl get pod --namespace ig-demo
kubectl get services --namespace ig-demo
```

## Demo 1: TCP connection issue

Let's try to use the app by accessing the ingress IP we are using to expose the
app to the Internet:

```bash
kubectl get ingress store-front --namespace ig-demo \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

Open the browser and access the URL:

```bash
http://<INGRESS_IP>
```

### App architecture

Before we start troubleshooting, let's check the architecture of the demo
application:

TODO: Add app architecture diagram

The application is composed by the following components:

- **store-front**: The front-end service that exposes the UI. Notice is uses a
  `ClusterIP` service type, and uses a [managed NGINX ingress
  controller](https://docs.azure.cn/en-us/aks/app-routing?tabs=default%2Cdeploy-app-default)
  (also called `store-front`) to exposes the front-end service to the Internet.
- **product-service**: The back-end service that handles products.
- **order-service**: The back-end service that handles orders. When an order is
  placed, it "manages" the order by forwarding the request to the `rabbitmq`
  service (which just enqueues the order). Additionally, if the product is
  "*Inspektor Gadget*", the `order-service` service will try to establish a HTTP
  connection to the `myexternalserver.com` server. This is a custom server that
  we will use to simulate a DNS issue.

### TCP Troubleshooting

Let's fist focus on the front-end service:

TODO: Add diagram for Internet <-> NGINX ingress <-> store-front

```bash
kubectl logs --namespace ig-demo --selector app=store-front
```

Of course, we can try to identify the IPs' owners...

```bash
kubectl get pods -A -o wide | grep <IP>
```

... but, there is an easier approach: Use [Inspektor Gadget](https://inspektor-gadget.io/).

#### Inspektor Gadget approach

Let's start by [installing the Inspektor Gadget CLI for Kubernetes](https://inspektor-gadget.io/docs/latest/quick-start#kubernetes):

```bash
kubectl krew install gadget
```

Then, deploy Inspektor Gadget to the cluster:

```bash
kubectl gadget deploy
```

Verify successful deployment:

```bash
kubectl gadget version
```

Now, let's run the [trace_tcp
gadget](https://inspektor-gadget.io/docs/latest/gadgets/trace_tcp) to trace the
TCP connections of the front-end service:

```bash
kubectl gadget run trace_tcp --namespace ig-demo --selector app=store-front
```

With flags:

- `--namespace ig-demo`: Namespace where the `store-front` service is running.
- `--selector app=store-front`: Label of the `store-front` service.

Now, given that we are filtering the events by the `store-front` service, we can
avoid printing the Kubernetes metadata, and just show the fields we are
interested in:

```bash
kubectl gadget run trace_tcp \
    --namespace ig-demo --selector app=store-front \
    --fields=src,dst,type,error
```

Now we are using the `--fields` flag to specify the fields we want to show:

- `src`: Source IP of the TCP event.
- `dst`: Destination IP of the TCP event.
- `type`: Type of TCP connection event. One of: `connect`, `accept`, `close`.
- `error`: Error of the event (if any).

### Fixing issue

The output shows that the `store-front` service accepted a connection from
the NGINX ingress controller, but it failed to connect to the `order-service`
service.

Let's check the logs of the `order-service` service:

```bash
kubectl logs --namespace ig-demo --selector app=order-service
```

The logs show that the `order-service` pod didn't receive any request
from the `store-front` service. So, let's check the `order-service` service
configuration:

```bash
code aks-store-ingress-quickstart.yaml
```

It's targeting the port `3001`, but the `order-service` pod is exposing
the port `3000`. Let's fix this by changing the `targetPort` of the
`order-service` service to `3000`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: order-service
spec:
  type: ClusterIP
  ports:
  - name: http
    port: 3000
    targetPort: 3000
  selector:
    app: order-service
```

And then, apply the changes:

```bash
kubectl apply -f aks-store-ingress-quickstart.yaml --namespace ig-demo
```

Wait for the app to be ready:

```bash
kubectl wait --for=condition=Ready pods --all --namespace ig-demo --timeout=120s
```

Now the app should be working.

## Demo 2: DNS issue

This demo is running in an AKS cluster with a custom DNS server. The custom DNS
server is running in a VM that is part of the same VNet as the AKS cluster. The
custom DNS server is running `dnsmasq` and is configured to resolve the
`myexternalserver.com` domain to the IP of a VM that is running a simple HTTP
server.

TODO: Add demo environment diagram

### Simulate an issue on the custom DNS server

Let's say that after running an update on the custom DNS server, the
configuration of `dnsmasq` was changed, and now the `myexternalserver.com`
domain is not resolving correctly. This is a common issue that can happen when
the DNS server is misconfigured or when the DNS server is not reachable.

In the DNS server VM, run the following command to simulate the issue:

```bash
# 1) SSH to the VM
ssh azureuser@<VM_PUBLIC_IP>

# 2) Change the dnsmasq configuration to simulate the issue
TODO: Create a script "upgrade-configuration.sh" with change on dnsmasq config + restart service
sudo tee /etc/dnsmasq.d/10-custom-hosts.conf <<EOF
# SIMULATE ISSUE:
# Send all myexternalserver.com lookups to 127.0.0.1#53535 (nothing is listening there)
server=/myexternalserver.com/127.0.0.1#53535
EOF
# Restart dnsmasq
sudo systemctl restart dnsmasq
```

Let's check how the DNS server behaves now:

```bash
# This should work
dig 127.0.0.1 microsoft.com +short

# This should NOT work
dig 127.0.0.1 myexternalserver.com +short
```

### DNS Troubleshooting

Now, let's check the logs of the `order-service` service to see if there are
any errors related to the DNS resolution:

```bash
kubectl logs --namespace ig-demo --selector app=order-service
```

The logs show that the `order-service` service is trying to resolve the
`myexternalserver.com` domain, but it is failing with error: `EAI_AGAIN`.

Let's use the [trace_dns
gadget](https://inspektor-gadget.io/docs/latest/gadgets/trace_dns). It allows us
to trace the DNS queries and responses across the whole cluster:

```bash
kubectl gadget run trace_dns:main -A
```

For this particular case, let's use the following flags to analyse the DNS
traffic between the `order-service` service and the `kube-dns` service:

TODO: Add diagram for order-service <-> kube-dns

```bash
kubectl gadget run trace_dns:main --namespace ig-demo --selector app=order-service --filter qtype==A,name==myexternalserver.com. --fields src,dst,nameserver,name,id,qr,rcode
```

Again, we use the `--namespace` and `--selector` flags to filter the events by
the `order-service` service:

- `--namespace ig-demo`: Namespace where the `order-service` service is
  running.
- `--selector app=order-service`: Label of the `order-service` service.

In addition, we use the `--filter` flag to filter the events we are
interested in:

- `qtype==A`: We are only interested in A records (IPv4 addresses).
- `name==myexternalserver.com.`: We are only interested in the
  `myexternalserver.com` domain.

Finally, we can use the `--fields` flag to specify the fields we want to show:

- `src`: Source IP of the DNS query/response.
- `dst`: Destination IP of the DNS query/response.
- `nameserver`: IP of the DNS server that was used to resolve the domain.
- `name`: Domain name being queried.
- `id`: DNS query/response ID, used to match queries with responses.
- `qr`: Specifies whether this message is a query (`Q`), or a response (`R`).
- `rcode`: Response code. One of: `Success`, `FormatError`, `ServerFailure`, `NameError`, `NotImplemented`, `Refused`.

In its output, we can see the requests coming from the `order-service` pod to the
`kube-dns` service, but all of them are getting `ServerFailure` as response
code.

Now, let's focus on the DNS traffic between the `kube-dns` service and the
custom DNS server:

TODO: Add diagram for kube-dns <-> Custom DNS server

```bash
kubectl gadget run trace_dns:main --namespace kube-system --selector k8s-app=kube-dns --filter qtype==A,nameserver.addr==10.224.0.91,name==myexternalserver.com. --fields src,dst,nameserver,name,id,qr,rcode
```

This time are filtering the events by the `kube-dns` service:

- `--namespace kube-system`: Namespace where the `kube-dns` service is
  running.
- `--selector k8s-app=kube-dns`: Label of the `kube-dns` service.

Additionally, we are using the `--filter` flag to continue filtering by `qtype`
and `name`, but also by the `nameserver.addr` field:

- `nameserver.addr==<Custom DNS server IP>`: This allows us to see all the
  traffic going and coming from the custom DNS server.

While the fields are the same as before.

The output shows that the `core-dns` pods send several queries to the custom
DNS server, but they never get a response.

Using Inspektor Gadget, we can also verify the general health of the custom DNS
server:

```bash
kubectl gadget run trace_dns:main \
    --namespace kube-system \
    --selector k8s-app=kube-dns \
    --filter nameserver.addr==10.224.0.91 \
    --fields name,id,qr,qtype,rcode,latency_ns
```

However, given that it's a very common configuration, we can create a gadget
manifest instance instead of running the command manually. This will allow us to
reuse it and share it easily.

```bash
code ig-demo/upstream-dns-health.yaml
```

And we can run it with the following command:

```bash
kubectl gadget run -f ig-demo/upstream-dns-health.yaml
```

The output will confirm that the custom DNS server is reachable but it's not
replying to the queries related with the `myexternalserver.com` domain.

In another terminal, try an extra query to check the health of the upstream DNS
server:

```bash
kubectl run -ti demo --namespace ig-demo --rm --image=busybox
```

```bash
nslookup example.com
```

## Extra demo: Reducing the number of DNS queries for external URLs

First of all, fix the DNS server configuration to make it work again:

```bash
# Fix custom DNS server
TODO: Create a script "fix.sh"
sudo tee /etc/dnsmasq.d/10-custom-hosts.conf <<EOF
# WORKING SCENARIO:
# Resolve custom host
address=/myexternalserver.com/10.224.0.92
EOF

# Restart dnsmasq
sudo systemctl restart dnsmasq

# Check it is working
dig 127.0.0.1 myexternalserver.com +short
dig 127.0.0.1 microsoft.com +short
```

Now, run again Inspektor Gadget to check the number of queries for the external
URLs:

```bash
kubectl gadget run trace_dns:main \
    --namespace ig-demo --selector app=order-service \
    --filter 'qr==Q,qtype==A,name~^myexternalserver.com.*' \
    --fields src,nameserver,name
```

This time we are using a regular expression to match all the queries that
start with `myexternalserver.com`. This will allow us to see all the queries
that are generated by the `order-service` service: 

- `myexternalserver.com.ig-demo.svc.cluster.local.`
- `myexternalserver.com.svc.cluster.local`
- `myexternalserver.com.cluster.local.`
- `myexternalserver.com.`
- And some others...

### Best practice tips

If you're experimenting this issue, it's recommended to use the fully qualified
domain name (FQDN) for the external URLs. This will help to reduce the number
of DNS queries generated by the application.
In this case, we can use the `myexternalserver.com.` domain instead of
`myexternalserver.com` in the `order-service` code.

```bash
code src/order-service/routes/root.js
```

```bash
docker build -t ghcr.io/blanquicet/order-service:ig-demo src/order-service
docker push ghcr.io/blanquicet/order-service:ig-demo
```

Now, restart the `order-service` deployment to apply the changes:

```bash
kubectl rollout restart deployment order-service --namespace ig-demo
```

Wait for the app to be ready:

```bash
kubectl wait --for=condition=Ready pods --all --namespace ig-demo --timeout=120s
```

Now, let's run again the `trace_dns` gadget to check the number of queries for
the external URLs:

```bash
kubectl gadget run trace_dns:main \
    --namespace ig-demo --selector app=order-service \
    --filter 'qr==Q,qtype==A,name~^myexternalserver.com.*' \
    --fields src,nameserver,name
```

The output should show that the number of queries has been reduced to only
one query for the `myexternalserver.com.` domain.

--------------------------

# Clean up:
PREFIX="build-demo"
LOCATION="westus3"

RESOURCE_GROUP="$PREFIX-rg"
NODE_RESOURCE_GROUP="$VMNAME-rg"
CLUSTER_NAME="$PREFIX-cluster"
VMNAME="$PREFIX-vm6"
PUBLIC_IP_NAME="tmp-pip"
NIC_NAME=${VMNAME}Nic

PROVIDER_ID=$(kubectl get nodes -o jsonpath='{.items[0].spec.providerID}')
echo "PROVIDER_ID=$PROVIDER_ID"

NODE_RESOURCE_GROUP=$(echo $PROVIDER_ID | sed -n 's|.*/resourceGroups/\([^/]*\)/providers/.*|\1|p')
echo "NODE_RESOURCE_GROUP=$NODE_RESOURCE_GROUP"

IPCONFIG_NAME=$(az network nic ip-config list \
  --resource-group $NODE_RESOURCE_GROUP \
  --nic-name       $NIC_NAME \
  --query "[0].name" -o tsv)
echo "IPCONFIG_NAME=$IPCONFIG_NAME"

###
# Remove the Public IP from the NIC, and then the Public IP
az network nic ip-config update \
  --resource-group      $NODE_RESOURCE_GROUP \
  --nic-name            $NIC_NAME \
  --name                $IPCONFIG_NAME \
  --remove              publicIpAddress
az network public-ip delete \
  --resource-group $NODE_RESOURCE_GROUP \
  --name          $PUBLIC_IP_NAME

###
# Delet Disk, VM and then NIC
az vm delete \
    --resource-group $NODE_RESOURCE_GROUP \
    --name $VMNAME \
    --yes
az network nic delete \
  --resource-group $NODE_RESOURCE_GROUP \
  --name $NIC_NAME

###
# Delete cluster
az aks delete \
  --name $CLUSTER_NAME \
  --resource-group $RESOURCE_GROUP \
  --yes

az group delete \
  --name $RESOURCE_GROUP \
  --yes



### Server VM ###
SERVER_VMNAME="$PREFIX-server-vm"
USERNAME="azureuser"
SERVER_VM_NIC_NAME=${SERVER_VMNAME}Nic
SERVER_VM_PUBLIC_IP_NAME="server-tmp-pip"

# Create a NIC in your VNet/Subnet/NSG without a public IP
# By default this NIC will have no public-IP resource attached
# Set Azure DNS server (168.63.129.16) as DNS server
az network nic create \
  --resource-group $NODE_RESOURCE_GROUP \
  --name $SERVER_VM_NIC_NAME \
  --vnet-name $VNET_NAME \
  --subnet    $SUBNET_NAME \
  --network-security-group $NSG_NAME \
  --dns-servers 168.63.129.16
echo "SERVER_VM_NIC_NAME=$SERVER_VM_NIC_NAME"

az vm create \
  --resource-group $NODE_RESOURCE_GROUP \
  --name $SERVER_VMNAME \
  --nics $SERVER_VM_NIC_NAME \
  --image Canonical:ubuntu-24_04-lts:server:latest \
  --admin-username $USERNAME \
  --generate-ssh-keys

# Expose to acces it via SSH

# Retrieve ipconfig name to then update the public IP
IPCONFIG_NAME=$(az network nic ip-config list \
  --resource-group $NODE_RESOURCE_GROUP \
  --nic-name      $SERVER_VM_NIC_NAME \
  --query "[0].name" -o tsv)
echo "IPCONFIG_NAME=$IPCONFIG_NAME"

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

# Create server

# 1) (Optional) install python3 if you don’t have it
sudo apt update && sudo apt install -y python3

# 2) pick (or create) a directory to serve files from
mkdir -p ~/www && echo "Hello from $(hostname)" > ~/www/index.html
cd ~/www

# 3) run a simple HTTP server on port 80 (In background)
sudo nohup python3 -m http.server 80 >/dev/null 2>&1 &

SERVER_VM_PRIVATE_IP=$(az network nic ip-config show \
  --resource-group      $NODE_RESOURCE_GROUP \
  --nic-name            $SERVER_VM_NIC_NAME \
  --name                $IPCONFIG_NAME \
  --query privateIPAddress -o tsv)
echo "SERVER_VM_PRIVATE_IP=$SERVER_VM_PRIVATE_IP"

# Remove the Public IP from the NIC, and then the Public IP
az network nic ip-config update \
  --resource-group      $NODE_RESOURCE_GROUP \
  --nic-name            $SERVER_VM_NIC_NAME \
  --name                $IPCONFIG_NAME \
  --remove              publicIpAddress
az network public-ip delete \
  --resource-group $NODE_RESOURCE_GROUP \
  --name          $SERVER_VM_PUBLIC_IP_NAME
  
#################
