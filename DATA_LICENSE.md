# Data license

This document is about the **data** the MaStR API returns — which is **separate**
from the license of this tool's **code** (see [LICENSING.md](LICENSING.md)).

> **We provide the tool, not the data.** `marktstammdatenregister-cli` is an
> independent client. It bundles no data. What you retrieve is governed by the terms
> of the data provider.

## Who provides the data

The **Marktstammdatenregister (MaStR)** is operated by the **Bundesnetzagentur**
(Federal Network Agency). It is the official register of the German electricity and
gas market.

## The licence — DL-DE-BY-2.0

The public MaStR data is published under the **Datenlizenz Deutschland – Namensnennung
– Version 2.0** (Data Licence Germany – Attribution – 2.0), **`dl-de/by-2-0`**. This is
an **open** licence: you may copy, use, redistribute, adapt, and combine the data,
including commercially, **provided you give attribution**.

- Licence text: <https://www.govdata.de/dl-de/by-2-0>

### Required attribution

Name the source (and, per the licence, a reference to the dataset/terms). A suitable
form:

> Datenquelle: Marktstammdatenregister der Bundesnetzagentur, lizenziert unter
> [DL-DE-BY-2.0](https://www.govdata.de/dl-de/by-2-0) — abgerufen am `<Datum>`.

Keep the attribution when you republish or build products on the data.

## What is NOT published (by law)

The register withholds some data — this is a legal restriction, not a gap in this tool:

- **Data of natural persons** and data classified as **confidential** under the
  Marktstammdatenregisterverordnung are not published. Operator names of private
  individuals appear **anonymised** (e.g. `natürliche Person (ABR…)`).
- For units with a **net capacity below 30 kW**, some **location** information is
  restricted.

Do not attempt to de-anonymise or re-identify withheld data.

## Not legal advice

This summary is a good-faith description, not legal advice, and the upstream terms can
change. When in doubt, consult the licence text and the MaStR
[Nutzungsbedingungen](https://www.marktstammdatenregister.de/MaStR). If you find the
terms have changed, please open an issue so this file can be updated.
