export default function StoreMap() {
  return (
    <div className="store-map">
      <img src="/store-map.png" alt="Floor plan of the shop" useMap="#departments" width="400" height="300" />
      <map name="departments">
        <area shape="rect" coords="0,0,200,300" href="/departments/houseplants" alt="Houseplants" />
        <area shape="rect" coords="200,0,400,300" href="/departments/garden-tools" />
      </map>
    </div>
  );
}
