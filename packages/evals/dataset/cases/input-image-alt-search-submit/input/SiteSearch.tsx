export default function SiteSearch() {
  return (
    <form role="search" action="/search">
      <label htmlFor="site-search">Search plants</label>
      <input id="site-search" type="search" name="q" />
      <input type="image" src="/icons/magnifier.svg" width="20" height="20" />
    </form>
  );
}
