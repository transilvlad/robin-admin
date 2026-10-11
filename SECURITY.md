# Security policy

## Supported versions

Robin Admin does not currently publish formal versioned releases beyond git
tags. Security fixes are applied to the `main` branch and released as the
current `latest` state of the project. If you are running an older tag or a
fork, please update to the current `main` before reporting an issue, if
practical, so we can confirm whether it is already fixed.

## Reporting a vulnerability

Please report security vulnerabilities privately rather than opening a public
GitHub issue. Email [transilvlad@gmail.com](mailto:transilvlad@gmail.com) with:

- A description of the vulnerability and its potential impact
- Steps to reproduce, or a proof of concept
- The affected file(s), endpoint(s), or component(s), if known
- Any suggested remediation, if you have one

We ask that you give us a reasonable opportunity to investigate and address a
report before any public disclosure (coordinated disclosure). There is no bug
bounty program associated with this project.

## What to expect

- Acknowledgment of your report within 5 business days.
- An initial assessment (severity and next steps) within 14 days of
  acknowledgment.
- Notification when a fix is merged to `main`, and credit in the fix's commit
  or release notes if you would like it.

## Scope and areas of particular interest

Robin Admin is an administration console for a mail-server fleet: it handles
mailbox and alias management, scoped API keys, fleet-agent communication, and
integrations with internal services (Robin, Rspamd, ClamAV, Dovecot, Postfix,
Redis, PostgreSQL). Reports involving any of the following are especially
welcome:

- Authentication or session handling bypass
- Credential handling, storage, or exposure (admin passwords, API keys,
  service secrets)
- Server-side request forgery (SSRF), particularly around fleet-agent or
  integration URLs
- Privilege escalation across admin roles (viewer / editor / admin)
- Injection (SQL, command, or configuration injection)

## Build dependency security

The Tailwind CSS 4 migration removes the frontend's `braces` dependency chain,
which was affected by [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
This is dependency removal, not an advisory suppression or an upstream patch.
The production frontend continues to serve compiled static assets with Nginx.

Keep content globs and build configuration repository-controlled. Do not pass
uploaded files, request parameters or other untrusted patterns into the build
pipeline, and do not expose development servers publicly. Review untrusted
contributions before privileged builds; use isolated, time-bounded CI jobs
without deployment secrets. Audit development as well as runtime dependencies
after build-tool updates, and rerun frontend tests and production builds.

Thank you for helping keep Robin Admin and its operators safe.
