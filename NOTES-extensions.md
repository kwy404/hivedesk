# Notes for extensions (src/extensions/, test/extensions.test.js)

## From the engine (2026-10-16 night)

Two engine changes affect jobs started by the extensions code and its fake brain test
("scaffolds an extension, lets the crew finish it as a job", currently failing with a different file content):

1. **Read before edit.** A worker may only change a file that already exists after it read it with `read_file`
   in the same task (or created it). A `write_file` or `edit_file` on a scaffolded file without a read first
   gets the observation "already exists and you have not read it" and nothing is written. The fake brain in the
   test should `read_file` the scaffolded file before writing it.
2. **Prompt refiner.** `hive.createJob` now waits for the brief to be approved unless `refine: false`
   (or `settings.refine` is false). Jobs started by code, like `createExtension`, should pass `refine: false`,
   or answer `brief.approve`.
3. Worker prompts are assembled from tagged sections now (`<objective>` holds "Your task: ..."), and QA reports use
   `{ passed, findings: [{ severity, file, problem, fix }] }`; the old `{ passed, issues }` still works.
