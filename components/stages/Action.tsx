export default function Action({ label, disabled = false, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <div className="actions">
      <button className="primary" id="advance" disabled={disabled} onClick={onClick}>{label}</button>
    </div>
  );
}
