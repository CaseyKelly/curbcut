import { wcagUnderstandingUrl } from '@/lib/wcag';
import type { GroupView, ScanView } from '@/lib/scan-view';
import { ImpactBadge } from './impact-badge';

const linkClass = 'text-blue-800 underline hover:no-underline';

/** What to say in place of an explanation, from where the scan's explain job stands. */
function missingExplanation(stage: ScanView['stage'], explainStatus: ScanView['explainStatus']) {
  if (stage === 'explaining') return 'Writing an explanation…';
  if (explainStatus === 'failed') {
    return 'Explanations aren’t available for this scan, so this is axe’s own description.';
  }
  return 'No explanation could be written for this rule, so this is axe’s own description.';
}

/** One rule's issues (#8): impact, explanation, WCAG and axe links, and the affected elements. */
export function IssueGroup({
  group,
  stage,
  explainStatus,
}: {
  group: GroupView;
  stage: ScanView['stage'];
  explainStatus: ScanView['explainStatus'];
}) {
  const headingId = `group-${group.groupKey}`;
  const { explanation } = group;
  const shown = group.elements.length;

  return (
    <article aria-labelledby={headingId} className="rounded-lg border border-neutral-300 p-4">
      <h3 id={headingId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ImpactBadge impact={group.impact} />
        <code className="text-lg font-semibold">{group.ruleId}</code>
        <span className="font-normal text-neutral-700">
          {group.count} {group.count === 1 ? 'element' : 'elements'}
        </span>
      </h3>
      <p className="mt-2 text-neutral-700">{group.help}</p>

      {explanation ? (
        <dl className="mt-4 space-y-3">
          <div>
            <dt className="font-semibold">What’s wrong</dt>
            <dd>{explanation.whatsWrong}</dd>
          </div>
          <div>
            <dt className="font-semibold">Who it affects</dt>
            <dd>{explanation.whoItAffects}</dd>
          </div>
          <div>
            <dt className="font-semibold">Why it matters</dt>
            <dd>{explanation.whyItMatters}</dd>
          </div>
          <div>
            <dt className="font-semibold">Confidence</dt>
            <dd>{Math.round(explanation.confidence * 100)}%</dd>
          </div>
        </dl>
      ) : (
        <p className="mt-4 text-neutral-700 italic">{missingExplanation(stage, explainStatus)}</p>
      )}

      <p className="mt-4">
        <a href={group.helpUrl} className={linkClass} target="_blank" rel="noreferrer">
          axe rule {group.ruleId}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        {group.wcag.length > 0 ? (
          <>
            {' · WCAG '}
            {group.wcag.map((criterion, i) => {
              const url = wcagUnderstandingUrl(criterion);
              return (
                <span key={criterion}>
                  {i > 0 ? ', ' : null}
                  {url ? (
                    <a href={url} className={linkClass} target="_blank" rel="noreferrer">
                      {criterion}
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  ) : (
                    criterion
                  )}
                </span>
              );
            })}
          </>
        ) : null}
      </p>

      <details className="mt-4">
        <summary className="cursor-pointer font-medium">Affected elements ({group.count})</summary>
        {shown < group.count ? (
          <p className="mt-2 text-neutral-700">
            Showing the first {shown} of {group.count}.
          </p>
        ) : null}
        <ul className="mt-2 space-y-4">
          {group.elements.map((element, i) => (
            <li key={`${element.pageUrl}|${element.selector}|${i}`}>
              <p>
                <code className="font-semibold break-all">{element.selector}</code>
              </p>
              <pre className="mt-1 rounded-md bg-neutral-100 p-2 text-sm break-words whitespace-pre-wrap">
                <code>{element.html}</code>
              </pre>
              {element.failureSummary ? (
                <p className="mt-1 text-sm whitespace-pre-line text-neutral-700">
                  {element.failureSummary}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}
