# Secrets & Leak Review Pattern Catalog

Comprehensive catalog of sensitive patterns, file types, and suppression pragmas for `sdw-security-checks`.

## Pattern Catalog

### API Keys & Credentials

| Pattern | Description | Default Severity |
|---------|-------------|------------------|
| `\bAKIA[0-9A-Z]{16}\b` | AWS Access Key ID | HIGH |
| `\b(gh[ps]_[a-zA-Z0-9]{36,}\|github_pat_[a-zA-Z0-9]{36,})\b` | GitHub Personal Access Token (classic or fine-grained) | HIGH |
| `\bxox[bpras]-[0-9a-zA-Z-]{24,}\b` | Slack bot/user/app token | HIGH |
| `\bsk-[a-zA-Z0-9]{32,}\b` | OpenAI / Stripe secret key | HIGH |
| `-----BEGIN (RSA \|EC \|DSA \|OPENSSH \|PGP )?PRIVATE KEY-----` | Cryptographic private key block | HIGH |
| `(postgresql\|mysql\|mongodb(\+srv)?\|redis\|jdbc)://[^:\s]+:[^@\s]+@` | Database URI containing embedded password | HIGH |
| `Bearer\s+[A-Za-z0-9\-._~+/]{40,}` | Generic Authorization Bearer token | MEDIUM |

### Sensitive File Types

| File Pattern | Description | Default Severity |
|--------------|-------------|------------------|
| `\.env$` | Root or nested `.env` file | HIGH |
| `\.env\.(?!example$)[^/\\]+$` | Specific environment secrets (e.g. `.env.production`) | HIGH |
| `\.pfx$\|\.p12$` | PKCS#12 certificate and key bundles | HIGH |
| `secrets\.ya?ml$` | Structured credentials / secrets file | HIGH |
| `credentials\.(json\|toml)$` | Cloud or service credential manifests | HIGH |
| `id_(rsa\|ecdsa\|ed25519)$` | SSH private keys | HIGH |
| `\.(pem\|key)$` | Standalone certificates or keys | MEDIUM |

### PII Patterns (Informational / Audit)

| Pattern | Description |
|---------|-------------|
| `\d{3}\.?\d{3}\.?\d{3}-?\d{2}` | CPF (Brazilian Taxpayer ID) |
| `\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}` | CNPJ (Brazilian Company ID) |
| `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` | Email Address |
| `\+?\d{1,3}[\s.-]?\(?\d{2,3}\)?[\s.-]?\d{4,5}[\s.-]?\d{4}` | Phone Number |
| `\b(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)\d{1,3}\.\d{1,3}\b` | RFC 1918 Private IP Address |
| `\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b` | Credit Card Number shape |

## .gitignore Advisories

Repositories should ignore sensitive files to prevent accidental staging:

```gitignore
# Secrets and environment files
.env
.env.*
!.env.example
*.pem
*.key
*.pfx
*.p12
secrets.yml
secrets.yaml
credentials.json
credentials.toml
.aws/
config/credentials
```

## False-Positive Suppression

When a secret-like string is required for tests or documentation, suppress the detection by appending the pragma anywhere on the line:

```javascript
const MOCK_API_KEY = "sk-0123456789abcdef0123456789abcdef"; // pragma: allowlist secret
```

The scanner checks for `allowlist secret` (case-insensitive) and ignores matching lines. Lines matching standard test strings (e.g. containing `EXAMPLE`, `[REDACTED]`, or AWS doc test keys) are also excluded.
