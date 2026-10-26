# Method: which invoices are in the payment run

The task asks for the average amount of an invoice in this week's payment run. The run pays `open` invoices only: `disputed` invoices are held back and `paid` ones are done. The reference gives the right average.

Judge the method the reply describes, then its figure. Score from 0 to 1:

- **1.0**: the reply says the average is taken over the open invoices alone, so disputed invoices are in neither the total nor the number of invoices, and its figure equals the reference.
- **0.7**: the method is right and stated, but the figure is off by rounding, or the reply does not say how it treated disputed invoices.
- **0.3**: disputed invoices are counted in the number of invoices (for example with their amounts set to zero), or paid invoices are included.
- **0.0**: the reply gives no method, or a figure with no stated basis.
