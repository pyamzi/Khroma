# Khroma

A hosted service where photographers and other creative studios keep their own images, deliver them to clients, and pull them into websites and designs through Claude alongside free-license media.

## Accounts and people

**Studio**:
The account that signs up and pays. A Studio owns a Library, a team, and its Clients; it can be a single person.
_Avoid_: Member, workspace, account, tenant, user

**Team member**:
A person who works inside a Studio, with the role owner or member.
_Avoid_: Member (as an account), staff, user

**Client**:
A person the Studio works for and delivers images to.
_Avoid_: customer, user, Member

**Project**:
One engagement for a Client, such as a wedding, holding its photos and the state of its booking and delivery.
_Avoid_: shoot, job, gallery

## Plans and billing

**Plan**:
The subscription level a Studio is on: Free, Solo, Pro, or Agency. A Plan sets how many Library photos, searches a month, and Team members the Studio gets.
_Avoid_: tier, package, subscription level, "Studio plan"

**Trial**:
The 14 days of Pro every new Studio gets at signup without a card, after which it moves to Free unless the owner picks a Plan.
_Avoid_: free trial period, demo

**Grace period**:
The 90 days after a Trial ends or a paid Plan lapses during which nothing is deleted, the Studio can still view, download, and deliver, but cannot upload. At its end the Studio keeps only what its Plan allows.
_Avoid_: suspension, read-only mode

## Media

**Library**:
Every image and video a Studio has uploaded, whether or not it belongs to a Project. It is visible only to the Studio's team; a Client sees an item only once it is published to their gallery. Distinct from the music library of songs for slideshows.
_Avoid_: uploads, assets, media library

**Culling preview**:
A temporary copy of a raw shot shown to a Client so they can pick favorites. It is not part of the Library: it does not count toward a Plan, is not searchable, and is deleted 30 days after the Client finishes picking.
_Avoid_: proof, RAW preview, thumbnail

**Free media**:
Works found through a Provider under a free license: Creative Commons, public domain, the Pexels License, or the Pixabay Content License.
_Avoid_: Creative Commons images, stock, stock photos

**Provider**:
A search service Khroma queries for Free media, such as Openverse, Pexels, or Pixabay.
_Avoid_: Source, API, backend

**Source**:
The collection that hosts a work and whose page its credit links to, such as Wikimedia Commons, Flickr, or Pexels. One Provider can return works from many Sources: Openverse returns works hosted on Flickr, Wikimedia Commons, and museum collections.
_Avoid_: Provider, origin, host
