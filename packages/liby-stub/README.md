# @snout/liby (stub)

Liby, the butterfly in SnoutData Studio, is free but not open source: her drawing, her model, her
behaviour and every line she says are SnoutData's and ship only in the official build. This
package stands in for her when Studio is built from the open-source tree. It exports what Studio
imports from `@snout/liby` and `@snout/liby/studio`, and none of it does anything: `<Liby />`
renders nothing, every call to her is a no-op, the tour uses the app's own words, and the help
shortcut opens the assistant instead.

One export draws something: `LibyFromAbove`, which in the official build is her seen from above
inside a host drawing (the About banner), is a neutral mark here, a tinted disc with the house spark,
so that drawing has no hole and carries none of her paths.

A build of this repository always uses this stub (`apps/studio/scripts/liby.mjs`). SnoutData's
official build carries the companion in its place. `npm run typecheck:public` in
`apps/studio` compiles Studio against this stub; it is part of `npm run typecheck`, so a new import
from her that is not here fails there first.

The types here are a SUBSET of hers, copied where Studio builds a value of them. Keep them in step
by running that check, not by reading her source.
