export default function DeliveryTable() {
  return (
    <table>
      <caption>Delivery options</caption>
      <thead>
        <tr>
          <th id="delivery-option">Option</th>
          <th id="delivery-cost">Cost</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td headers="delivery-option">Standard</td>
          <td headers="delivery-cost">£4.50</td>
        </tr>
        <tr>
          <td headers="delivery-option">Next day</td>
          <td headers="delivery-cost">£7.00</td>
        </tr>
      </tbody>
    </table>
  );
}
