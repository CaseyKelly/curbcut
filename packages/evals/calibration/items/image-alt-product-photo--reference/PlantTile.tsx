type Plant = { name: string; price: number; image: string };

const plant: Plant = { name: 'Boston fern', price: 24, image: '/plants/boston-fern.jpg' };

export default function PlantTile() {
  return (
    <article className="plant-tile">
      <img src={plant.image} alt={plant.name} width={240} height={240} />
      <h3>{plant.name}</h3>
      <p className="price">£{plant.price}</p>
      <button type="button">Add to cart</button>
    </article>
  );
}
