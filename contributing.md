# Contributing

Bug fixes, documentation improvements, tests, and new features are welcome.

## Reporting bugs

- Search [existing issues][githubissues] before opening a report.
- If no issue covers the problem, [open one][githubnewissue] with a clear title,
  reproduction steps, expected behavior, actual behavior, and relevant logs or
  a minimal test case.

## Submitting a change

- Describe the problem and proposed approach before starting a substantial feature.
- Follow the existing coding style and naming conventions.
- Keep warning suppressions as narrow as possible.
- Run the relevant checks:

```bash
npm run build
npm run lint
npm test
```

- Open a pull request with a clear description and link any related issue.

## Cosmetic changes

- Changes that are cosmetic in nature and do not add anything substantial to the stability,
functionality, or testability will generally not be accepted.

## New features

- Discuss substantial changes in an issue before writing code. This helps avoid
  duplicated or conflicting work.

## Questions

- Email the [project maintainer][mailinglist]. Responses depend on maintainer availability.

## Documentation

- Start with the [documentation index](doc/README.md).
- Documentation corrections follow the same pull-request process as code changes.

## Thank you

Thank you for contributing to Robin Admin.

[githubissues]: https://github.com/transilvlad/robin-admin/issues
[githubnewissue]: https://github.com/transilvlad/robin-admin/issues/new
[mailinglist]: mailto:transilvlad@gmail.com
