export default function HeaderSearch() {
  return (
    <form action="/search">
      <label htmlFor="header-search">Find a plant</label>
      <input id="header-search" type="search" name="q" />
      <button type="submit" className="magnifier-icon"></button>
    </form>
  );
}
