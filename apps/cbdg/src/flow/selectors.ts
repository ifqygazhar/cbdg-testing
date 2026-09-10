// ── Flow selectors (human-meaningful needles from the captured dataset) ──
// Text matchers are lowercase **strings** (the dom helpers do substring `includes`
// on lowercased page text). Regex matchers are only used by our own body waiter.

export const Selectors = {
  // Pricing page entry → new-user bonus signup (from captured intl-signup-bonus block:
  //   title: "New user bonus" / desc: "Sign up and get 250 welcome credits" / button: "Sign Up Now")
  pricingBonusSignup: ["sign up now", "new user bonus", "250 welcome credits"] as const,

  // /register/user/complete
  // Region needle includes the country NAME too — the captured page shows the
  // option label "Singapore", which does not contain the code "sg".
  registerRegionToggle: ["select registration region", "current region"] as const,
  registerRegion: (code: string): readonly string[] => {
    const c = code.toLowerCase();
    const aliases: Record<string, readonly string[]> = {
      sg: ["sg", "singapore"],
      id: ["id", "indonesia"],
      us: ["us", "united states"],
    };
    return aliases[c] ?? [c];
  },
  registerSubmit: "submit" as const,

  // Account menu → payment profile → harvestsharp token
  accountMenu: "account" as const,
  paymentProfile: "payment profile" as const,
  midasTokenField: 'input[name="xMidasToken"]',
  harvestSignUrl: /card\.harvestsharp\.com\/apps\/creditcard\/views\/sign/,

  // Midas card form (names confirmed in midaspayment.html)
  firstName: 'input[name="cardHolderFirstName"]',
  lastName: 'input[name="cardHolderLastName"]',
  cardNumber: 'input[name="cardInputNum"]',
  expiry: 'input[name="cardExpiryDate"]', // MM/YY placeholder
  cvc: 'input[name="cardCVC"]',
  billingCity: 'input[name="billingAddressCity"]',
  billingPostal: 'input[name="billingAddressPostalCode"]',
  billingState: 'input[name="billingAddressStateOrProvince"]',
  billingPhone: 'input[name="billingAddressPhoneNumber"]',
  billingCountry: 'select#billingAddressCountry_select',
  phoneCountry: 'select#phoneNumberCountryCode_select',
  linkCard: "link your card" as const,

  // 3DS vs success indicators (regex — used by waitForBodyRegex)
  mida3ds: /verif|3ds|secure|otp|enter code|verify your card/,
  midaSuccess: /success|linked|verified|card has been/,

  // Trial + credit verify
  trial7d: ["7-day pro free trial", "7-day free trial", "start trial", "activate trial"] as const,
  plansUsage: "https://www.codebuddy.ai/profile/plans-usage?amount=0",
  creditBanner: /(500|250)/,
  /**
   * Signup-only mode expects just the new-user welcome credits (250 per the
   * pricing page), since no trial has been started. Kept separate from
   * `creditBanner` so the two modes cannot silently accept each other's
   * evidence.
   */
  welcomeCreditBanner: /250|welcome credit/,
} as const;