# Working in this repo

## Git workflow

Commit and push directly to `main`. Do not create feature/topic branches, and do not open pull
requests — there is no branch to open one from. `main` is the only branch; treat every push to it
as the deliverable, not a draft.

This means there is no PR review gate before a change lands. Run the test suite
(`npm test`) before pushing, since it is the only check a change gets.
