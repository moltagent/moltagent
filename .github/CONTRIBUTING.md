# Contributing to Moltagent

Thank you for your interest. This project is built by a solo founder with Claude as an implementation partner. Contributions from humans are welcome and valued.

## Ways to contribute

### Report bugs

Found something broken? [Open an issue](https://github.com/moltagent/moltagent/issues/new?template=1-bug-report.yml) with steps to reproduce, expected vs actual behavior, your environment details, and relevant logs.

### Suggest features

Have an idea? [Start a discussion](https://github.com/moltagent/moltagent/discussions/new?category=ideas) first. This helps us understand the use case, discuss approaches, and avoid duplicate work.

### Improve documentation

Documentation improvements are always welcome: fix typos, clarify confusing sections, add examples, translate to other languages. Moltagent is multilingual by default (DE/EN/PT), and documentation should follow that principle.

### Submit code

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run the test suite: `npm test`
5. Commit with clear messages: `Add: feature description`
6. Push to your fork: `git push origin feature/my-feature`
7. Open a Pull Request

## Development setup

Moltagent requires a Nextcloud backend to run. For development, you need:

- Node.js 20+
- A Nextcloud instance with the Passwords, Deck, Collectives, and Talk apps
- A `moltagent` user account in Nextcloud
- Ollama (optional, for local LLM testing)

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/moltagent.git
cd moltagent

# Install dependencies
npm install

# Copy and configure
# Edit the provider config with your Nextcloud URL and Ollama endpoint
nano config/moltagent-providers.yaml

# Run tests
npm test
```

The full three-VM production setup is documented in [docs/quickstart.md](docs/quickstart.md). For development, a single machine with Nextcloud accessible is sufficient.

## Code guidelines

### Style

- 2-space indentation
- Meaningful variable names
- Comments for complex logic
- Functions focused and small
- No language-specific word lists or stop words in code (the LLM is the language layer)

### Commits

- Present tense: "Add feature" not "Added feature"
- Descriptive but concise
- Reference issues when relevant: "Fix #123: resolve timeout bug"
- Semantic commit messages reflecting real work, not cosmetic rewording

### Pull requests

- Describe what changes and why
- Link to related issues
- Include test results
- Be responsive to feedback

## Architectural principles

If you're contributing code, these principles matter:

- **No regex for intelligence.** If code is compensating for weak AI (keyword matching, language-specific guards, pattern detection on natural language), strengthen the AI component instead.
- **Multilingual by default.** Every feature must work in German and Portuguese on day one. If it only works in English, it's a prototype.
- **BUILT ≠ VERIFIED.** A fix is only complete after confirmed production behavior, not after tests pass.
- **Less code, not more.** If a commit adds more lines than it removes, question whether the altitude is right.

Read the `CLAUDE.md` file at repo root for the full engineering principles and anti-patterns to avoid.

## Security issues

**Do NOT open public issues for security vulnerabilities.**

Email [security@moltagent.cloud](mailto:security@moltagent.cloud) with:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

We will respond within 48 hours and work with you on a fix. See [SECURITY.md](SECURITY.md) for the full security policy.

## Code of conduct

Be kind. Be respectful. Assume good intentions. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Questions?

- [GitHub Discussions](https://github.com/moltagent/moltagent/discussions) for general questions
- [Issues](https://github.com/moltagent/moltagent/issues) for bug reports

Thank you for contributing.
