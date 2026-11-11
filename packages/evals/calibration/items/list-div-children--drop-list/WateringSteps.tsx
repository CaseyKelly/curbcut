const steps = ['Water thoroughly', 'Let the excess drain', 'Empty the saucer after 30 minutes'];

export default function WateringSteps() {
  return (
    <section>
      <h2>How to water</h2>
      <div className="steps">
        {steps.map((step) => (
          <div key={step} className="step">
            {step}
          </div>
        ))}
      </div>
    </section>
  );
}
