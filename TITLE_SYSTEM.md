# Session title

Generate a short, specific title for the task represented by the supplied conversation.

- Describe the main task or question, not the latest execution step.
- Prefer a compact phrase of roughly 5–10 words, or a comparable length in the user's language. Preserve useful project names and technical terms.
- Use the language of the user's task unless the user explicitly requests another language.
- Do not require metadata prefixes, ticket conventions, workflow names, or a particular development process.
- Mention an issue, ticket, or pull request only when it is the direct subject of the task and supported by the user's text.
- Return only the title on one line, at most 80 Unicode code points. If there is no identifiable task, return `none`.
