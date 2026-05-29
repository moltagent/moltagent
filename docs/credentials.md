# Credential Format Reference

Moltagent reads every secret it needs from the Nextcloud **Passwords** app. You create an entry there, share it with the `moltagent` user, and the agent fetches it on demand.

This page documents the exact mapping between the NC Passwords UI fields and what the code reads, so you can configure each credential correctly the first time. The authority is the code: `src/lib/credential-cache.js` (`_processCredential`, `_extractHost`, `_parseExtras`) and the consumer of each credential.

## How a credential is shaped

When the agent fetches a credential by name, `_processCredential` decides its shape from the **name**:

- **Simple credential** — the entry's **Password** field value is the entire credential. The agent receives a single string.
- **Complex credential** — the agent builds an object from several NC Passwords fields. A credential is treated as complex when its name *contains* one of: `email-imap`, `email-smtp`, `caldav`, `oauth` (case-insensitive substring match). Everything else is simple.

> **Naming matters.** The complex/simple decision is a substring match on the name. `email-imap` and `google-oauth` are complex; a credential you call `mailbox` or `gmail` is simple (just a password string) even if you fill in extra fields. Name OAuth credentials so the name contains `oauth`.

### Where complex fields come from

For a complex credential, the object is assembled from these NC Passwords fields:

| Object field | Source NC Passwords field | Notes |
|---|---|---|
| `password` | Password | |
| `username` / `user` | Username | `user` is an alias for `username` |
| `host` | Website (URL) | Protocol stripped by `_extractHost` — `https://mail.example.com` becomes `mail.example.com` |
| `url` | Website (URL) | The raw value, protocol intact |
| `notes` | Notes | The raw text |
| *extras* | Notes (if valid JSON) **and** Custom fields | See below |

**Two surprising behaviors to know:**

1. **The Notes field is only parsed as JSON.** If Notes contains valid JSON (e.g. `{"port": 993, "tls": true}`), each key is merged into the credential object. If it contains anything else — including `key=value` lines like `port=993` — it is kept as plain text and **ignored** for configuration. `key=value` notes do nothing.
2. **Custom field values are always strings.** A custom field labelled `port` with value `993` arrives as the string `"993"`, not the number `993`. The consumers coerce as needed (`parseInt`, `=== 'true'`). Custom field labels are lower-cased before use, so `Port` and `port` are equivalent.

Extras (Notes-JSON keys and custom fields) are merged **last**, so a custom field or JSON key named `host` or `url` overrides the value derived from the Website field. The Website field is the normal way to set the host; custom fields are the normal way to set everything else.

---

## Simple credentials

For each of these, put the secret in the **Password** field and share the entry with `moltagent`. Username, Website, Notes, and custom fields are ignored.

| Credential name | What goes in Password | Notes |
|---|---|---|
| `nc-talk-secret` | The 128-char hex secret from `talk:bot:install` | Must be byte-identical to the secret used when the Talk bot was registered (see [Quick Start](quickstart.md) Step 5) |
| `nc-talk-room` | The Talk room token | The short string after `/call/` in the Talk URL when you are viewing the conversation. Tells the agent which room to listen in |
| `claude-api-key` | Anthropic API key (starts with `sk-ant-`) | Only needed if a cloud role uses Anthropic |
| `deepseek-api-key` | DeepSeek API key | Only needed if the DeepSeek provider is configured |

Any other LLM provider key (OpenAI, Mistral, Groq, …) follows the same pattern: the entry name must match the `credentialName` in your `config/moltagent-providers.yaml` provider block, and the key goes in the Password field. See [Configuration](configuration.md) and [LLM Providers](providers.md).

---

## Complex credentials

### `email-imap`

Consumer: `src/lib/handlers/email-handler.js` (`_fetchEmails`).

| NC Passwords field | Maps to | Example value | Required? |
|---|---|---|---|
| Password | `password` | (your IMAP password / app password) | Yes |
| Username | `username` / `user` | `you@example.com` | Yes |
| Website | `host` (protocol stripped) | `https://mail.example.com` | Yes |
| Custom field `port` | `port` | `993` (TLS) or `143` (STARTTLS) | Recommended (defaults to 993) |
| Custom field `starttls` | `starttls` | `true` | Only on port 143 |
| Custom field `tls` | `tls` | `false` to force-disable TLS on 993 | Rarely needed |
| Custom field `tlsSkipVerify` | `tlsSkipVerify` | `true` to accept a self-signed cert | Rarely needed |
| Notes | reference only — **not** parsed unless valid JSON | — | No |

**TLS is automatic from the port.** On port `993` the agent uses direct TLS without any extra field. On port `143` it uses STARTTLS automatically. You only need the `tls` / `starttls` fields to override these defaults.

**Gmail:** host `imap.gmail.com`, port `993`, and use a Google [app password](https://support.google.com/accounts/answer/185833) (not your account password). **Outlook/Office 365:** host `outlook.office365.com`, port `993`.

Equivalent configuration via JSON Notes instead of custom fields (either works):

```json
{"port": 993}
```

### `email-smtp`

Consumer: `src/lib/handlers/email-handler.js` (`confirmSendEmail`).

| NC Passwords field | Maps to | Example value | Required? |
|---|---|---|---|
| Password | `password` | (your SMTP password / app password) | Yes |
| Username | `username` / `user` | `you@example.com` | Yes |
| Website | `host` (protocol stripped) | `https://mail.example.com` | Yes |
| Custom field `port` | `port` | `587` (STARTTLS) or `465` (implicit TLS) | Recommended (defaults to 587) |
| Custom field `from` | `from` | `Your Name <you@example.com>` | No — defaults to the username |
| Notes | reference only — **not** parsed unless valid JSON | — | No |

**TLS is derived from the port.** Port `465` uses implicit TLS; port `587` uses STARTTLS. There is no separate field to set.

**Gmail:** host `smtp.gmail.com`, port `587`. **Outlook/Office 365:** host `smtp.office365.com`, port `587`.

### `caldav`

**You normally do not create a `caldav` credential.** The calendar integration (`src/lib/integrations/caldav-client.js`) authenticates as the `moltagent` Nextcloud user itself — it reuses the NC account password that systemd loads from the credential store (`/etc/credstore/moltagent-nc-password`) and talks to `remote.php/dav/calendars/<moltagent-user>/`. No separate `caldav` entry in NC Passwords is read by the current code.

`caldav` remains in the complex-credential list so that a future external-CalDAV consumer would receive the same `{password, username, host, url, …}` object shape as email. If that path is added, this section will document the fields it reads. For Nextcloud-hosted calendars today, just make sure the `moltagent` user's calendar is shared as described in the [Deployment Guide](deployment.md#calendar-setup).

### `oauth`

Consumer: `src/skill-forge/oauth-broker.js`. Used by SkillForge tools that call OAuth 2.0 APIs (Google, Microsoft, GitHub, …). The credential name is chosen per skill and **must contain the substring `oauth`** (e.g. `google-oauth`) so it is treated as complex.

| NC Passwords field | Maps to | Example value | Required? |
|---|---|---|---|
| Password | `client_secret` | (the OAuth app client secret) | Yes |
| Username | `client_id` (via `username` / `user`) | `1234567890-abc.apps.example.com` | Yes |
| Website | `token_endpoint` (via the raw `url`) | `https://oauth2.example.com/token` | Yes |
| Notes | token state, as JSON — **managed by the agent** | — | No (leave empty) |

Note that OAuth reads the **raw `url`** (full token endpoint, protocol intact), not the protocol-stripped `host` that email uses. After the consent flow completes, the agent writes the access/refresh tokens back into the Notes field as JSON. Leave Notes empty when you create the entry; do not hand-edit it afterward.

---

## Sharing and access

Every credential the agent uses must be **shared with the `moltagent` user** in NC Passwords. The agent can only see entries shared with it.

Keep anything the agent should never touch (banking, admin passwords, HR systems) in folders that are **not** shared with `moltagent`. The trust boundary is enforced by sharing: what isn't shared can't be read.

## Troubleshooting

- **"Email not configured" / empty IMAP result, but the entry exists.** Most often the host is missing because the **Website** field is empty, or the port is missing because it was written as `key=value` lines in Notes (which are ignored). Set the Website field and add `port` as a custom field (or valid JSON in Notes).
- **Credential not found at all.** Confirm the entry is shared with `moltagent` and that the name matches exactly (the lookup also matches the entry's Username and is case-insensitive on the label).
- **OAuth credential "incomplete".** The broker needs all three of Username (`client_id`), Password (`client_secret`), and Website (`token_endpoint`).

## See also

- [Quick Start](quickstart.md) — initial credential setup
- [Deployment Guide](deployment.md#credential-organization-in-nc-passwords) — credential organization and email setup
- [Security Model](security-model.md) — trust boundaries and credential brokering
