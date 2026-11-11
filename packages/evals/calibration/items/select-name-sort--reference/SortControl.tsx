import { useState } from 'react';

export default function SortControl() {
  const [sort, setSort] = useState('popular');
  return (
    <div className="toolbar">
      <label htmlFor="sort" className="toolbar-label">Sort by</label>
      <select id="sort" value={sort} onChange={(e) => setSort(e.target.value)}>
        <option value="popular">Most popular</option>
        <option value="price-asc">Price: low to high</option>
        <option value="price-desc">Price: high to low</option>
      </select>
    </div>
  );
}
