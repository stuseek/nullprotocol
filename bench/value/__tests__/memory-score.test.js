const { scoreProbe } = require('../memory-score');

const marta = {
  name: 'Marta Kowalski',
  order: '58213',
  newOrder: '58977',
  allergy: 'peanuts',
  city: 'Gdansk'
};
const score = answer => scoreProbe(marta, answer);

test('each fact is judged on its own: a missing city does not cancel a correct name', () => {
  expect(
    score(
      "Your name is Marta Kowalski and you're allergic to peanuts. I don't know which city you're writing from."
    )
  ).toMatchObject({ name: true, allergy: true, city: false, order: false });
});

test('a denied field is false, not review', () => {
  expect(score('The information you provided did not include your name or your city.')).toEqual({
    name: false,
    order: false,
    allergy: false,
    city: false
  });
});

test('quoting the customer back without asserting goes to review', () => {
  expect(
    score('You wrote "I\'m allergic to peanuts", but I cannot confirm your allergies.').allergy
  ).toBeNull();
});

test('the new order number is recall; the cancelled one is recall only as history', () => {
  expect(score('Your current order number is 58977.').order).toBe(true);
  expect(score('Your current order number is 58977, since order 58213 was cancelled.').order).toBe(
    true
  );
  expect(score('Your current order number is 58213.').order).toBe(false);
  expect(score('Your order numbers are 58213 and 58977.').order).toBeNull();
});

test("a number tied to a product is not the customer's order", () => {
  expect(
    score(
      "The reference data includes an order number 58977, which corresponds to the Ember table lamp.\nSince there is no specific order number mentioned, I don't have this information."
    ).order
  ).toBe(false);
});

// Saved answers from the pilot, scored against the manual review.
test.each([
  [
    'e9bd0ab849',
    'Your name is likely Marta, as you began by identifying yourself as "MartaKowalski."\nYour current order number is 58977, as you mentioned that you had a previous order (number 58213) that was cancelled and a new one placed.\nYou are allergic to peanuts.\nYou are writing from Gdansk.',
    { name: true, order: true, allergy: true, city: true }
  ],
  [
    '65c3c25715-like',
    'Your name is Marta Kowalski.\nYour current order number is 58213.\nYou mentioned you are allergic to peanuts.\nYou are writing from Gdansk.',
    { name: true, order: false, allergy: true, city: true }
  ],
  [
    '39ae0a69b9',
    'Your name is Marta Kowalski, your current order number is 58977, you are allergic to peanuts, and you are writing from Gdansk.',
    { name: true, order: true, allergy: true, city: true }
  ]
])('saved answer %s', (_, answer, expected) => {
  expect(score(answer)).toEqual(expected);
});
