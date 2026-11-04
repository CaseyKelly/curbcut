export default function StockDot() {
  return (
    <p className="stock">
      Monstera deliciosa{' '}
      <span
        role="img"
        aria-label="In stock"
        style={{ display: 'inline-block', width: 8, height: 8, background: '#15803d' }}
      />
    </p>
  );
}
