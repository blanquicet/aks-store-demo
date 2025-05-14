# Demo

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

## Demo 1: TCP connection issue

Let's try to use the app by accessing the ingress IP we are using to expose the
app to the Internet:

```bash
PIP=$(kubectl get ingress store-front --namespace ig-demo \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo "Public IP to access the app: $PIP"
```

Open the browser and access the URL:

```bash
http://<INGRESS_IP>
```

### App architecture

Before we start troubleshooting, let's check the architecture of the demo
application:

![Architecture Diagram](./Arch.png)

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

Start by checking pods' status:

```bash
kubectl get pod --namespace ig-demo
```

Let's fist focus on the front-end service:

TODO: Add an image where only ingress and front-end are highlighted

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
kubectl gadget run trace_tcp \
    --namespace ig-demo --selector app=store-front
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
    --fields=type,src,dst,error
```

Now we are also using the `--fields` flag to specify the fields we want to show:

- `type`: Type of TCP connection event. One of: `connect`, `accept`, `close`.
- `src`: Source IP of the TCP event.
- `dst`: Destination IP of the TCP event.
- `error`: Error of the event (if any).

Reproduce the issue by opening the browser and accessing the URL
`http://<INGRESS_IP>` so that we capture all the TCP events.

The output shows that:

- The `store-front` service accepted a connection from the managed NGINX ingress controller.
- The `store-front` service successfully connected to the `product-service`.
- The `store-front` service closed the connection to the `product-service`.
- The `store-front` service failed to connect to the `order-service` service with error `ECONNREFUSED`.

This means that the issue is not related to the communication between the
`store-front` service and the `product-service` service ...

TODO: Add an image where only ingress and front-end and product-service are
highlighted

... but rather to the communication between the `store-front` service and the
`order-service` service.

### Fixing issue

Now, let's focus on the communication between the `store-front` and the
`order-service` service:

![order-service](./order-service.png)

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

### Intro to DNS

TODO: Add a diagram with the DNS behaviour in AKS

### Using a custom DNS server

This demo is running in an AKS cluster with a custom DNS server. The custom DNS
server is running in a VM that is part of the same VNet as the AKS cluster. The
custom DNS server is running `dnsmasq` and is configured to resolve the
`myexternalserver.com` domain to the IP of a VM that is running a simple HTTP
server.

TODO: Add demo environment diagram (Probably a copy of the external DNS scenario
with the custom DNS server and the HTTP server)

### Simulate an issue on the custom DNS server

Let's say that after running an update on the custom DNS server, the
configuration of `dnsmasq` was changed, and now the `myexternalserver.com`
domain is not resolving correctly. This is a common issue that can happen when
the DNS server is misconfigured or when the DNS server is not reachable.

In the DNS server VM, run the following command to simulate the issue:

```bash
# 1) SSH to the VM
ssh azureuser@<VM_PUBLIC_IP>

# 2) Run the following command to simulate the issue
update-dns-configuration.sh
```

Let's check how the DNS server behaves now:

```bash
# This should work
dig 127.0.0.1 microsoft.com +short

# This should NOT work
dig 127.0.0.1 myexternalserver.com +short
```

### DNS Troubleshooting

This is the scenario we are going to troubleshoot:

![order-service-internet](./order-service-internet.png)

TODO: Explain a bit more

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
kubectl gadget run trace_dns:main \
    --namespace ig-demo --selector app=order-service \
    --filter qtype==A,name==myexternalserver.com. \
    --fields src,dst,nameserver,name,id,qr,rcode
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
kubectl gadget run trace_dns:main \
    --namespace kube-system --selector k8s-app=kube-dns \
    --filter qtype==A,nameserver.addr==10.224.0.91,name==myexternalserver.com. \
    --fields src,dst,nameserver,name,id,qr,rcode
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
    --namespace kube-system --selector k8s-app=kube-dns \
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
# 1) SSH to the VM
ssh azureuser@<VM_PUBLIC_IP>

# 2) Run the following command to fix the issue
fix-dns-configuration.sh
```

Let's check how the DNS server behaves now:

```bash
# This should work
dig 127.0.0.1 microsoft.com +short

# This should also work
dig 127.0.0.1 myexternalserver.com +short
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
