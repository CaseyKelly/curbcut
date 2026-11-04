const rating = 4;

export default function ProductRating() {
  return (
    <div className="rating">
      <div
        role="img"
        style={{
          width: 80,
          height: 16,
          background: `linear-gradient(90deg, #b45309 ${rating * 20}%, #d6d3d1 0)`,
        }}
      />
      <a href="#reviews">128 reviews</a>
    </div>
  );
}
