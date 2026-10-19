# Order-service review requirements

Review the committed order_service.py change against these behavior contracts. Inspect implementation behavior, not naming or prose style. Report concrete violations with the affected function and explanation.

Read can_fulfil only. It returns true only when every requested item has sufficient stock; a shortage on any line returns false, including when an earlier line has enough stock.

Read load_order only. Missing files and malformed JSON propagate an exception to the caller instead of being converted into an empty order.

Read release_expired only. It releases every expired reservation, including adjacent expired entries, removes those entries, and leaves unexpired reservations intact.

Read subtotal only. It includes price times quantity for every cart line, including the last line, and returns Decimal zero for an empty cart.
