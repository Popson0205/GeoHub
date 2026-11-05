# Licence keys: for customers who run GeoEstate software themselves

Most customers use GeoEstate's own Geohub, where their licences are kept for them. A customer that runs the software
on its own servers, or in its own cloud account, gets a **licence key** instead: a signed text that lists the customer,
the installation's web address, and each product's plan, kind, dates, caps and feature switches.

```
GEOESTATE-LICENCE-1.<the contents, base64url JSON>.<GeoEstate's Ed25519 signature>
```

## On GeoEstate's own Geohub (issuing keys)

1. Set `LICENCE_SIGNING_SECRET` to 32+ random characters, once, and keep it: it is what makes keys genuine.
2. On a customer's page in the staff console, **Licence keys → Make a licence key**: the installation's web address,
   optionally one end date for everything, and a note. The key carries the customer's licences as they stand on its
   page (Geohub and every other product). Copy it or download it, and send it to the customer.
3. Every key issued is listed there, and can be shown again.
4. The public key, under the card, is what installations need. It can only check keys, never make them.

To renew: renew the licences on the customer's page, then make a new key.

## On the customer's installation

| Variable | Value |
| --- | --- |
| `LICENCE_REQUIRED` | `true` |
| `LICENCE_PUBLIC_KEY` | GeoEstate's public key, from the staff console |
| `APP_URL` | the installation's address: the key must be made for it |
| `SINGLE_ORG`, `ORG_NAME` | `true`, and the customer's name (a private copy for one organization) |
| `LICENCE_KEY` | optional: the key, installed on the first start |

The organization's owner or an administrator pastes each key under **Organization settings → Licence key**. The key is
the whole truth: the licences it lists are set from it, and products it leaves out are taken away (their data stays).
Installing works even while the installation is read-only or closed, so a renewal always gets through.

Without a key, the installation gives everyone full use for 14 days from its first start, then becomes read-only, as
any licence does after its end date.

A key cannot be changed (one changed character and the signature fails), and a key made for one address is refused
by another. To fix GeoEstate's public key into the software itself, so that it cannot be changed with a setting, add it
to `PINNED` in `backend/app/licence_keys.py`.
