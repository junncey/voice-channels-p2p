## Native HTTPS (optional)

![https](https.png)

The server picks its protocol by certificate presence at startup:

- **No certs (default)** — plain HTTP on `PORT`. This is the expected form when a
  reverse proxy (nginx / caddy / traefik …) terminates TLS in front of the server.
- **`app/ssl/key.pem` + `app/ssl/cert.pem` both present** — the port serves
  **HTTPS only** (native TLS, e.g. direct exposure without a proxy).

The demo self-signed certificate that upstream shipped here has been removed —
generate or mount real certificates for the native-HTTPS form:

```bash
# self-signed certificate (browser warnings apply)
openssl genrsa -out key.pem
openssl req -new -key key.pem -out csr.pem
openssl x509 -req -days 9999 -in csr.pem -signkey key.pem -out cert.pem
rm csr.pem

# real deployment: prefer a certificate from your CA (Let's Encrypt, …)
```

Docker: mount the two files at `/src/app/ssl/`. Note the same port no longer
accepts HTTP and HTTPS simultaneously (the retired `httpolyglot` behavior) —
a second port or a redirecting proxy is needed if both protocols are required.
See `docs/self-hosting.md` for the deployment forms.
