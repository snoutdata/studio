# studio-pro (stub)

Data Flows (the extraction pipeline: sources, readers, the local extraction model, generation,
cloud and log sources, schedules, vector sinks and search) is part of the official SnoutData Studio
build and is not open source. This package stands in for it when Studio is built from the
open-source tree: the same interface, with nothing behind it.

- `main.ts`: Data Flows' main half. Registers no handlers and runs nothing.

A build of this repository always uses this stub (`apps/studio/scripts/pro.mjs`). SnoutData's
official build carries Data Flows in its place.
