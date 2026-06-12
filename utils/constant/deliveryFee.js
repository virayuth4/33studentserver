
//Utils to calculate delivery fee
function getDeliveryFee(paymentMethod) {
  const fees = {
    aba: 1.0,
    cod: 2.0,
  };

  return fees[paymentMethod] ?? 1.0;
}

module.exports = {
  getDeliveryFee
}