export default function Pagination() {
  return (
    <nav aria-label="Pagination">
      <span>Page 2 of 9</span>
      <a href="/plants?page=3" className="arrow-right">
        Next page
      </a>
    </nav>
  );
}
