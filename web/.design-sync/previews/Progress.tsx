import { Progress } from '@access0x1/web'

// The primary axis is `value` (0-100) — swept, per its real use as the 0-100
// trust meter in components/verification/VerificationLevels.tsx.
export const Values = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 320 }}>
    <Progress value={0} />
    <Progress value={35} />
    <Progress value={75} indicatorClassName="bg-accent" />
    <Progress value={100} indicatorClassName="bg-[hsl(var(--success))]" />
  </div>
)
