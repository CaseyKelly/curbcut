const utilities = `
  .bg-white { background-color: #ffffff; }
  .text-gray-400 { color: #9ca3af; }
  .text-gray-700 { color: #374151; }
`;

export default function CareTip() {
  return (
    <div className="bg-white">
      <style>{utilities}</style>
      <p className="text-gray-400">Water once the top inch of soil is dry.</p>
    </div>
  );
}
