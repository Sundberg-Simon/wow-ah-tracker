export interface ConnectedRealmIndexResponse {
  connected_realms: { href: string }[];
}

export interface ConnectedRealmResponse {
  id: number;
  realms: {
    id: number;
    slug: string;
    name: string;
  }[];
  population?: { type: string };
  status?: { type: string };
}

interface AuctionItemModifier {
  type: number;
  value: number;
}

export interface Auction {
  id: number;
  item: {
    id: number;
    context?: number;
    bonus_lists?: number[];
    modifiers?: AuctionItemModifier[];
  };
  buyout?: number;
  unit_price?: number;
  quantity: number;
  time_left: string;
}

export interface AuctionsResponse {
  connected_realm?: { href: string };
  auctions: Auction[];
}

export interface Commodity {
  id: number;
  item: { id: number };
  quantity: number;
  unit_price: number;
  time_left: string;
}

export interface CommoditiesResponse {
  auctions: Commodity[];
}
