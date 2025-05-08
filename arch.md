flowchart LR
  subgraph "My Cluster"
    SF[Front-end]
    OS[Order service]
    PS[Product Service]
    OQ[(Order Queue)]
  end

  Customers[Customers] --> SF
  SF --> OS
  SF --> PS
  OS -.-> ES[External server]
  OS --> OQ
