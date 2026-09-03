// components/RetractionNotice.jsx — the app-wide retraction alert. One card per saved paper
// PubMed now classifies as a Retracted Publication that the clinician has not yet acted on.
// Rendered above every surface except the Library, which shows the same alerts with the
// delete action beside them (deletion lives there because concept membership is scrubbed
// there). "Keep with warning" persists on the record, so the alert stays dismissed on every
// device; the row warning in the Library is permanent either way.

export default function RetractionNotice({ alerts = [], onKeep, onOpenLibrary }) {
  if (!alerts.length) return null
  return (
    <div style={{ margin: '0 0 22px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {alerts.map((paper) => (
        <div key={paper.id} role="alert" style={{ borderRadius: 12, border: '1px solid rgba(224,96,90,.45)', background: 'rgba(224,96,90,.10)', padding: '13px 15px' }}>
          <p style={{ margin: 0, fontSize: 12, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--color-domain-vascular)' }}>Retracted · saved paper</p>
          <p style={{ margin: '5px 0 0', fontSize: 13.5, fontWeight: 600, lineHeight: 1.45, color: 'var(--color-fg-soft)' }}>{paper.title || `PMID ${paper.pmid}`}</p>
          <p style={{ margin: '4px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--color-fg-muted)' }}>
            PubMed now classifies this paper in your Library as a Retracted Publication. It is excluded from Connections and concept summaries. Keep it with a permanent warning, or delete it from the Library.
          </p>
          <div className="flex flex-wrap" style={{ marginTop: 10, gap: 8 }}>
            <button onClick={() => onKeep?.(paper)} className="cursor-pointer" style={{ borderRadius: 8, border: '1px solid rgba(255,255,255,.14)', background: 'transparent', color: 'var(--color-fg-soft)', padding: '6px 10px', fontSize: 12, fontFamily: 'inherit' }}>Keep with warning</button>
            <button onClick={() => onOpenLibrary?.(paper)} className="cursor-pointer" style={{ borderRadius: 8, border: 0, background: 'rgba(224,96,90,.18)', color: 'var(--color-domain-vascular)', padding: '6px 10px', fontSize: 12, fontWeight: 700, fontFamily: 'inherit' }}>Review in Library</button>
            <a href={paper.citation?.url || `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`} target="_blank" rel="noopener noreferrer" style={{ alignSelf: 'center', fontSize: 12, color: 'var(--color-accent)' }}>PubMed record ↗</a>
          </div>
        </div>
      ))}
    </div>
  )
}
