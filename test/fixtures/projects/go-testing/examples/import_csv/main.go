// Command import_csv posts the entries of a CSV file to a ledger and prints the trial balance.
package main

import (
	"encoding/csv"
	"fmt"
	"os"
	"strconv"

	"example.com/ledger/ledger"
	"example.com/ledger/money"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: import_csv <file>")
		os.Exit(2)
	}
	file, err := os.Open(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer file.Close()
	book := ledger.Open(money.USD)
	rows, err := csv.NewReader(file).ReadAll()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for _, row := range rows {
		minor, _ := strconv.ParseInt(row[2], 10, 64)
		_ = book.OpenAccount(row[0])
		entry := ledger.NewEntry(row[3]).Debit(row[0], money.New(minor, money.USD)).Credit(row[1], money.New(minor, money.USD))
		_ = book.OpenAccount(row[1])
		if err := book.Post(entry); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}
	fmt.Println("trial balance:", book.TrialBalance())
}
