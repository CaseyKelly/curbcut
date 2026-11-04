const theme = {
  surface: '#ffffff',
  text: '#18181b',
  textMuted: '#52525b',
};

export default function DeliveryNote() {
  return (
    <div style={{ background: theme.surface, color: theme.text }}>
      <h2>Delivery</h2>
      <p style={{ color: theme.textMuted }}>Arrives in three to five working days.</p>
    </div>
  );
}
