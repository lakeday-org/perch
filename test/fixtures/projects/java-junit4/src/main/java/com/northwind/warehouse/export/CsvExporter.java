package com.northwind.warehouse.export;

import com.northwind.warehouse.model.Location;
import com.northwind.warehouse.model.Sku;
import com.northwind.warehouse.model.StockLevel;
import com.northwind.warehouse.stock.StockRepository;
import java.io.IOException;
import java.io.Writer;
import java.util.List;
import java.util.Map;

/** Writes a stock count sheet as CSV for the quarterly audit. */
public class CsvExporter {
    private final StockRepository repository;

    public CsvExporter(StockRepository repository) {
        this.repository = repository;
    }

    public void write(List<Sku> skus, Writer out) throws IOException {
        out.write("sku,location,on_hand,reserved\n");
        for (Sku sku : skus) {
            for (Map.Entry<Location, StockLevel> entry : repository.locationsOf(sku).entrySet()) {
                out.write(String.join(",", sku.toString(), entry.getKey().toString(),
                        Integer.toString(entry.getValue().onHand()), Integer.toString(entry.getValue().reserved())));
                out.write('\n');
            }
        }
    }

    static String escape(String field) {
        if (field.contains(",") || field.contains("\"")) {
            return '"' + field.replace("\"", "\"\"") + '"';
        }
        return field;
    }
}
