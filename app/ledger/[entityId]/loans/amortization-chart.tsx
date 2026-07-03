type Pt = { date: string; interestCents: number; principalCents: number };

/**
 * The amortization signature moment: interest (oxblood) vs principal (evergreen)
 * per payment, so you can SEE the month the loan flips from mostly-interest to
 * mostly-principal — the crossover. The 360-row table is the detail below this.
 */
export function AmortizationChart({ schedule }: { schedule: Pt[] }) {
  const n = schedule.length;
  if (n < 2) return null;

  const W = 720, H = 220, padL = 8, padR = 8, padT = 16, padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const maxY = Math.max(...schedule.map((r) => Math.max(r.interestCents, r.principalCents)), 1);

  const x = (i: number) => padL + (i / (n - 1)) * innerW;
  const yI = (v: number) => padT + innerH - (v / maxY) * innerH;

  const line = (sel: (r: Pt) => number) =>
    schedule.map((r, i) => `${x(i).toFixed(1)},${yI(sel(r)).toFixed(1)}`).join(" ");

  const crossIdx = schedule.findIndex((r) => r.principalCents >= r.interestCents);
  const crossX = crossIdx > 0 ? x(crossIdx) : null;
  const crossDate = crossIdx > 0 ? schedule[crossIdx].date : null;

  // year ticks
  const ticks: { i: number; label: string }[] = [];
  let lastYr = "";
  schedule.forEach((r, i) => {
    const yr = r.date.slice(0, 4);
    if (yr !== lastYr && (+yr % 5 === 0 || i === 0 || i === n - 1)) {
      ticks.push({ i, label: `’${yr.slice(2)}` });
      lastYr = yr;
    }
  });

  const areaPrincipal =
    `${line((r) => r.principalCents)} ${x(n - 1).toFixed(1)},${(padT + innerH).toFixed(1)} ${x(0).toFixed(1)},${(padT + innerH).toFixed(1)}`;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-oxblood" /> Interest</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-evergreen" /> Principal</span>
        {crossDate && (
          <span className="ml-auto">
            Principal overtakes interest · <span className="font-medium text-foreground">{crossDate.slice(0, 7)}</span>
          </span>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Amortization: interest vs principal per payment">
        {/* baseline */}
        <line x1={padL} y1={padT + innerH} x2={W - padR} y2={padT + innerH} stroke="var(--hair)" />
        {/* principal area */}
        <polygon points={areaPrincipal} fill="var(--evergreen-soft)" />
        {/* crossover marker */}
        {crossX !== null && (
          <line x1={crossX} y1={padT} x2={crossX} y2={padT + innerH} stroke="var(--ink)" strokeOpacity="0.18" strokeDasharray="3 3" />
        )}
        {/* lines */}
        <polyline points={line((r) => r.interestCents)} fill="none" stroke="var(--oxblood)" strokeWidth="2" strokeLinejoin="round" />
        <polyline points={line((r) => r.principalCents)} fill="none" stroke="var(--evergreen)" strokeWidth="2" strokeLinejoin="round" />
        {/* x ticks */}
        {ticks.map((t) => (
          <text key={t.i} x={x(t.i)} y={H - 8} fontSize="10" fill="var(--faint)" textAnchor="middle" fontFamily="var(--font-sans)">
            {t.label}
          </text>
        ))}
      </svg>
      <p className="text-xs text-faint">
        Early payments are mostly interest; the lines cross when principal takes over. Total interest over
        the life of the loan is the area under the red line.
      </p>
    </div>
  );
}
