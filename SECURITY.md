# Security policy

## Supported versions

Security fixes go into the latest 1.x release.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting
at https://github.com/OWNER/silk/security/advisories/new and include steps to
reproduce. You should get a reply within a week.

## Scope notes

- `silk ui` binds to 127.0.0.1 by default and accepts only JSON POST bodies. Do not expose it on a public interface: anyone who can reach it can start crawls from your machine.
- `silk ask --llm` sends the question and the top passages to the provider whose API key is set. Nothing else is sent.
- The MCP server runs with the permissions of the user who starts it and can read and write the file paths an agent passes to it.
