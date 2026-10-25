package main

import (
	"log"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/plugins/migratecmd"

	"ledgerflow/pb"
	_ "ledgerflow/pb/migrations"
)

func main() {
	app := pocketbase.New()

	migratecmd.MustRegister(app, app.RootCmd, migratecmd.Config{
		Dir: "pb/migrations",
	})

	pb.RegisterRoutes(app)

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}
