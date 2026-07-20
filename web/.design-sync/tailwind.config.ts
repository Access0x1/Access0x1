// design-sync Tailwind config — extends the real app config (untouched) with
// .design-sync/previews/**/*.tsx added to `content`.
//
// Why this exists: tailwind.config.ts's `content` globs only scan app/,
// components/, lib/ — the app's own source. Tailwind's JIT compiler only
// emits CSS for classes it can see in those files, so any utility class used
// ONLY in an authored preview (not already present somewhere in the real
// app source) compiles to nothing — the class exists in the HTML but has no
// rule, so it silently has zero visual effect. Confirmed on Progress.tsx's
// `bg-[hsl(var(--success))]`: absent from the compiled CSS, bar rendered
// unfilled instead of green.
import base from '../tailwind.config'

const config = {
  ...base,
  content: [...base.content, '.design-sync/previews/**/*.tsx'],
}

export default config
