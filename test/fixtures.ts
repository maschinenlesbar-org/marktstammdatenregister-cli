// Canned MaStR response bodies for the unit suite, shaped like the live API:
// the Kendo envelope `{ Data, Total, AggregateResults, Errors }`, and the
// filter-columns array. Dates are the Microsoft-AJAX `/Date(ms)/` strings.

export const unitPage = {
  Data: [
    {
      Id: 1796071,
      MaStRNummer: "SEE984033548619",
      EinheitName: "Photovoltaikanlage ERWin4",
      BetriebsStatusName: "In Betrieb",
      EnergietraegerName: "Solare Strahlungsenergie",
      Bruttoleistung: 3.96,
      Bundesland: "Nordrhein-Westfalen",
      Ort: "Münster",
      EinheitRegistrierungsdatum: "/Date(1548979200000)/",
      InbetriebnahmeDatum: "/Date(1184889600000)/",
    },
    {
      Id: 2,
      MaStRNummer: "SEE000000000002",
      EinheitName: "PV Zwei",
      BetriebsStatusName: "In Betrieb",
      EnergietraegerName: "Solare Strahlungsenergie",
      Bruttoleistung: 10,
      Bundesland: "Bayern",
      Ort: "München",
      EinheitRegistrierungsdatum: "/Date(1600000000000)/",
      InbetriebnahmeDatum: null,
    },
  ],
  Total: 9063887,
  AggregateResults: null,
  Errors: null,
};

/** The server's reply when the Kendo request bound to null (group/filter missing). */
export const nullRequestError = {
  Data: null,
  Total: 0,
  AggregateResults: null,
  Errors: "Die Anfrage ist Null.",
};

export const filterColumns = [
  {
    FilterName: "Art der Solaranlage",
    Type: "multidropdown",
    ListObject: [
      { Name: "Freiflächensolaranlage", Value: "852" },
      { Name: "Gebäudesolaranlage", Value: "853" },
    ],
  },
  { FilterName: "Bruttoleistung der Einheit", Type: "number", ListObject: [] },
];
