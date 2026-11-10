# ADC backend

Does: cloud Android devices through a worker-owned ADB bridge.

- Ownership comes from the allocation journal and API origin. An unreadable API is not device loss.
- Journal the activation key before creation; replay an unanswered request with that key.
- Recovery keeps the same device. Shutdown releases its data; a later boot starts fresh.
- Simlock owns the access TTL. ADC runs until release or device failure.
- ADC owns its ADB server; it never adopts the local backend's server. Preserve the allocation's relay port across reconnects.
