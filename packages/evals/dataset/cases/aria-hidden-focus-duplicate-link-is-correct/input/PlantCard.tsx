export default function PlantCard() {
  return (
    <article className="plant-card">
      <a href="/plants/pilea" aria-hidden="true" tabIndex={-1}>
        <img src="/pilea.jpg" alt="" />
      </a>
      <h2>
        <a href="/plants/pilea">Chinese money plant</a>
      </h2>
    </article>
  );
}
