# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| `main`  | ✅ Current production branch |
| `next`  | ⚠️ Development branch, best-effort fixes |

Moltagent is in beta. We take security seriously at every stage.

## Reporting a vulnerability

**Do NOT open public issues for security vulnerabilities.**

### How to report

Email [security@moltagent.cloud](mailto:security@moltagent.cloud) with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional)

### What to expect

- **Acknowledgment** within 48 hours
- **Assessment and timeline** within 7 days
- **Fix or mitigation** as fast as possible, prioritized by severity
- **Credit** in the release notes (unless you prefer to stay anonymous)

We follow coordinated disclosure. We ask that you give us reasonable time to address the issue before public disclosure.

## Security architecture

Moltagent is designed with security as a structural property, not a feature layer:

- **Three-VM isolation** separates Nextcloud, the agent runtime, and local LLM inference
- **Runtime credential brokering** through NC Passwords. API keys are fetched at the moment of use and immediately discarded. Never stored on disk
- **Trust boundaries** classify every input as trusted or untrusted. Sensitive operations route to the air-gapped local LLM automatically
- **Network segmentation** restricts each VM to only the connections it needs. The Ollama VM has no internet access
- **Instant revocation** by disabling the agent's Nextcloud account or revoking individual credentials
- **Audit logging** of all security-relevant operations

For the full security model, see [docs/security-model.md](docs/security-model.md).

## Scope

The following are in scope for security reports:

- Authentication and authorization bypasses
- Credential exposure or leakage
- Prompt injection attacks that bypass trust boundaries
- Privilege escalation
- Data exfiltration paths
- Audit log tampering or evasion

The following are out of scope:

- Vulnerabilities in Nextcloud itself (report to [Nextcloud Security](https://nextcloud.com/security/))
- Vulnerabilities in Ollama (report to [Ollama](https://github.com/ollama/ollama/security))
- Vulnerabilities in upstream LLM providers
- Denial of service against self-hosted infrastructure
- Social engineering

## Contact

Email: [security@moltagent.cloud](mailto:security@moltagent.cloud)
