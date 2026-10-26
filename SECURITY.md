# Security Policy

## Reporting a Vulnerability

If you have discovered a security issue in **Voice Channels P2P**, please report it
privately through [GitHub Security Advisories](https://github.com/junncey/voice-channels-p2p/security/advisories/new).
Please refrain from creating a public issue or disclosing the vulnerability publicly.

We prefer a Coordinated Vulnerability Disclosure (CVD) so the root cause can be
understood and fixed before details become public.

When reporting, please include:

- affected version (`package.json` version or image tag) and commit if known;
- deployment mode (Docker image `b1at-public/voice-channels`, or bare `node app/src/server.js`);
- reproduction steps, and whether a TURN relay was in use;
- any relevant server log excerpt with secrets removed.

## Scope

This repository is a derivative work of [MiroTalk P2P](https://github.com/miroslavpejic85/mirotalk)
(AGPL-3.0). Video, screen sharing, whiteboard, file transfer and recording were
removed; the signalling layer, channel store, admin API and the whole frontend were
rewritten. In scope:

- the Node.js server in `app/src/` (signalling, channel/admin API, chat persistence, audit trail);
- the frontend in `public/`;
- the Docker image built from this repository.

If a defect is reproducible on upstream MiroTalk P2P **and** in this project because
the code is inherited unchanged, it is good practice to also notify the upstream
maintainers via <https://github.com/miroslavpejic85/mirotalk/security/advisories/new>.

## Out of scope

- Vulnerabilities in upstream code that this project no longer ships (video pipeline,
  screen sharing, whiteboard, file transfer, recording, Whisper transcription, webhooks,
  Kubernetes manifests).
- Misconfiguration of a third-party TURN/coturn server operated outside this repository.
- Findings that require a compromised host, browser extension, or physical access.
- Reports produced solely by an automated scanner without a demonstrated impact.

## Supported versions

Only the latest release tag receives security fixes. Older tags are kept for
reproducibility and rollback, not for backporting.

---

## Acknowledgements

Thanks to everyone who reports issues responsibly. Reporters are credited here
once a fix has been released, unless they prefer to stay anonymous.
